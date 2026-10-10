import { ConfigurationError } from "@pr-buddy/review-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiReviewer } from "../../src/ai-reviewer.js";
import { MAX_OUTPUT_TOKENS } from "../../src/limits.js";
import { SYSTEM_PROMPT } from "../../src/prompt/build-prompt.js";
import type { AiProvider, AiResponse } from "../../src/provider.js";
import { createScriptedProvider } from "../../src/scripted-provider.js";
import { parseAiSettings } from "../../src/settings.js";
import { addedFile, contextWith, reply } from "../helpers/context.js";

const FINDING = {
  message: "The result of read is returned without checking for failure.",
  severity: "medium",
  filePath: "src/loader.ts",
  line: 2,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createAiReviewer", () => {
  it("reports the provider and model it was given", () => {
    const reviewer = createAiReviewer({
      provider: createScriptedProvider([], { name: "example", model: "example-large-2" }),
    });

    expect(reviewer).toMatchObject({ provider: "example", model: "example-large-2" });
  });

  it.each([
    ["an empty name", { name: "" }],
    ["a name with Markdown", { name: "[x](https://evil.example)" }],
    ["a model with a space", { model: "big model" }],
    ["a model with a backtick", { model: "m`" }],
    ["a very long model", { model: "m".repeat(201) }],
  ])("refuses a provider with %s", (_name, identity) => {
    expect(() => createAiReviewer({ provider: createScriptedProvider([], identity) })).toThrow(
      ConfigurationError,
    );
  });

  it.each([0, -1, 1.5, 300_001])("refuses a time limit of %s ms", (timeoutMs) => {
    expect(() => createAiReviewer({ provider: createScriptedProvider([]), timeoutMs })).toThrow(
      ConfigurationError,
    );
  });
});

describe("a review", () => {
  it("sends one request and returns the verified suggestions", async () => {
    const provider = createScriptedProvider([
      { text: reply(FINDING), usage: { inputTokens: 420, outputTokens: 61 } },
    ]);
    const times = [1_000, 1_250];
    const reviewer = createAiReviewer({ provider, now: () => times.shift() ?? 0 });

    const review = await reviewer.review(contextWith());

    expect(review).toEqual({
      status: "completed",
      findings: [
        {
          ruleId: "ai-review",
          severity: "medium",
          confidence: 0.5,
          message: FINDING.message,
          evidence: [{ label: "Basis", value: "AI model suggestion, not verified" }],
          filePath: "src/loader.ts",
          line: 2,
        },
      ],
      suppressedFindingCount: 0,
      rejectedFindingCount: 0,
      sentFileCount: 1,
      omittedFileCount: 0,
      usage: { inputTokens: 420, outputTokens: 61 },
      durationMs: 250,
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      system: SYSTEM_PROMPT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    expect(provider.requests[0]?.signal.aborted).toBe(false);
    expect(provider.requests[0]?.user).toContain("return read();");
  });

  it("completes with nothing when the model finds nothing", async () => {
    const reviewer = createAiReviewer({ provider: createScriptedProvider(['{"findings":[]}']) });

    expect(await reviewer.review(contextWith())).toMatchObject({
      status: "completed",
      findings: [],
      rejectedFindingCount: 0,
    });
  });

  it("makes no request when nothing can be sent", async () => {
    const provider = createScriptedProvider([]);
    const reviewer = createAiReviewer({ provider });
    const context = contextWith({
      files: [
        addedFile(".env", "API_KEY=canary"),
        { path: "logo.png", status: "added", additions: 0, deletions: 0 },
      ],
    });

    const review = await reviewer.review(context);

    expect(review).toMatchObject({ status: "skipped", sentFileCount: 0, omittedFileCount: 1 });
    expect(provider.requests).toEqual([]);
  });

  it("never sends a credential file, and says a file was left out", async () => {
    const provider = createScriptedProvider(['{"findings":[]}']);
    const context = contextWith({
      files: [addedFile("src/a.ts", "const a = 1;"), addedFile("prod.pem", "KEY-canary")],
    });

    const review = await createAiReviewer({ provider }).review(context);

    expect(provider.requests[0]?.user).not.toContain("canary");
    expect(provider.requests[0]?.user).not.toContain("prod.pem");
    expect(review).toMatchObject({ status: "completed", sentFileCount: 1, omittedFileCount: 1 });
  });

  it("drops suggestions it cannot verify and counts them", async () => {
    const provider = createScriptedProvider([
      reply(
        FINDING,
        { ...FINDING, filePath: "src/other.ts" },
        { ...FINDING, line: 99 },
        "not a finding",
      ),
    ]);

    const review = await createAiReviewer({ provider }).review(contextWith());

    expect(review.findings).toHaveLength(1);
    expect(review.rejectedFindingCount).toBe(3);
  });

  it("refuses a suggestion about a file that was changed but not sent", async () => {
    const provider = createScriptedProvider([
      reply(
        { ...FINDING, filePath: ".env", line: 1 },
        { ...FINDING, filePath: ".env", line: null },
      ),
    ]);
    const context = contextWith({
      files: [addedFile("src/a.ts", "const a = 1;"), addedFile(".env", "API_KEY=1")],
    });

    const review = await createAiReviewer({ provider }).review(context);

    expect(review).toMatchObject({ status: "completed", findings: [], rejectedFindingCount: 2 });
  });

  it("applies reporting thresholds and counts what they hide", async () => {
    const provider = createScriptedProvider([
      reply({ ...FINDING, severity: "low", line: 1 }, { ...FINDING, severity: "high" }),
      reply(FINDING),
    ]);
    const reviewer = createAiReviewer({ provider });

    const bySeverity = await reviewer.review(contextWith(), {
      minSeverity: "medium",
      minConfidence: 0,
    });
    const byConfidence = await reviewer.review(contextWith(), {
      minSeverity: "low",
      minConfidence: 0.6,
    });

    expect(bySeverity.findings.map(({ severity }) => severity)).toEqual(["high"]);
    expect(bySeverity.suppressedFindingCount).toBe(1);
    expect(byConfidence).toMatchObject({
      status: "completed",
      findings: [],
      suppressedFindingCount: 1,
    });
  });
});

describe("a review that goes wrong", () => {
  it.each([
    ["prose", "Looks good to me!"],
    ["an oversized reply", "x".repeat(50_001)],
  ])("fails with invalid-response for %s", async (_name, text) => {
    const provider = createScriptedProvider([
      { text, usage: { inputTokens: 10, outputTokens: 5 } },
    ]);

    expect(await createAiReviewer({ provider }).review(contextWith())).toMatchObject({
      status: "failed",
      failureReason: "invalid-response",
      findings: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["text that is not a string", { text: 42 }],
  ])("fails with invalid-response when the provider returns %s", async (_name, answer) => {
    const provider: AiProvider = {
      name: "example",
      model: "m",
      complete: () => Promise.resolve(answer as unknown as AiResponse),
    };

    expect(await createAiReviewer({ provider }).review(contextWith())).toMatchObject({
      status: "failed",
      failureReason: "invalid-response",
    });
  });

  it.each([
    ["negative", { inputTokens: -1, outputTokens: 5 }],
    ["fractional", { inputTokens: 1.5, outputTokens: 5 }],
    ["missing a count", { inputTokens: 1 }],
    ["text", "many"],
  ])("keeps the reply and drops usage that is %s", async (_name, usage) => {
    const provider = createScriptedProvider([
      { text: reply(FINDING), usage } as unknown as AiResponse,
    ]);

    const review = await createAiReviewer({ provider }).review(contextWith());

    expect(review.status).toBe("completed");
    expect(review.findings).toHaveLength(1);
    expect(review).not.toHaveProperty("usage");
  });

  it("reports a provider error by name and never by message", async () => {
    class RateLimitError extends Error {
      override name = "RateLimitError";
    }
    const provider = createScriptedProvider([
      () => Promise.reject(new RateLimitError("prompt was: canary-prompt-text")),
    ]);

    const review = await createAiReviewer({ provider }).review(contextWith());

    expect(review).toMatchObject({
      status: "failed",
      failureReason: "provider-error",
      errorName: "RateLimitError",
      findings: [],
    });
    expect(JSON.stringify(review)).not.toContain("canary-prompt-text");
  });

  it.each([
    ["a thrown string", "canary thrown text"],
    ["an error with an unusual name", Object.assign(new Error("x"), { name: "canary name!" })],
  ])("reports %s as a plain Error", async (_name, thrown) => {
    const provider: AiProvider = {
      name: "example",
      model: "m",
      complete: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- providers are outside code
        throw thrown;
      },
    };

    const review = await createAiReviewer({ provider }).review(contextWith());

    expect(review).toMatchObject({ failureReason: "provider-error", errorName: "Error" });
    expect(JSON.stringify(review)).not.toContain("canary");
  });

  it("gives up after the time limit and tells the provider to stop", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const provider = createScriptedProvider([
      (request) => {
        ({ signal } = request);
        return new Promise<AiResponse>(() => undefined);
      },
    ]);
    const reviewer = createAiReviewer({ provider, timeoutMs: 5_000 });

    const pending = reviewer.review(contextWith());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toMatchObject({ status: "failed", failureReason: "timeout" });
    expect(signal?.aborted).toBe(true);
  });

  it("fails with provider-error when the script has run out", async () => {
    const reviewer = createAiReviewer({ provider: createScriptedProvider([]) });

    expect(await reviewer.review(contextWith())).toMatchObject({
      status: "failed",
      failureReason: "provider-error",
    });
  });
});

describe("parseAiSettings", () => {
  it("is off when the section is missing or empty", () => {
    expect(parseAiSettings(undefined)).toEqual({ ok: true, settings: { enabled: false } });
    expect(parseAiSettings({})).toEqual({ ok: true, settings: { enabled: false } });
  });

  it("is on when enabled", () => {
    expect(parseAiSettings({ enabled: true })).toEqual({ ok: true, settings: { enabled: true } });
  });

  it.each([
    ["a value that is not a boolean", { enabled: "yes" }, "ai.enabled: "],
    ["an unknown field", { enabled: true, model: "x" }, "ai: "],
    ["a section that is not an object", true, "ai: "],
  ])("reports %s", (_name, value, prefix) => {
    const parsed = parseAiSettings(value);

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual([expect.stringContaining(prefix)]);
  });

  it("bounds the length of an issue", () => {
    const parsed = parseAiSettings({ ["k".repeat(5_000)]: true });

    expect(parsed.ok ? [] : parsed.issues.map((issue) => issue.length)).toEqual([300]);
  });
});
