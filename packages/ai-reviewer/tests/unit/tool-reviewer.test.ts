import type { ReviewFinding } from "@pr-buddy/review-engine";
import { describe, expect, it } from "vitest";
import type { ReadEvidence } from "../../src/output/to-findings.js";
import { TOOL_SYSTEM_PROMPT } from "../../src/prompt/build-tool-prompt.js";
import type { AiTurn } from "../../src/provider.js";
import { ProviderHttpError } from "../../src/providers/http.js";
import { createScriptedToolProvider } from "../../src/scripted-provider.js";
import { reviewWithTools } from "../../src/tool-reviewer.js";
import type { AiTool } from "../../src/tool.js";
import { addedFile, contextWith, reply } from "../helpers/context.js";

/** A record of what was read, as the runner keeps one. */
function createEvidence(): ReadEvidence & { readonly lines: Set<string> } {
  const lines = new Set<string>();
  return {
    lines,
    addLine: (path, line) => lines.add(`${path}:${line}`),
    hasLine: (path, line) => lines.has(`${path}:${line}`),
    hasFile: (path) => [...lines].some((entry) => entry.startsWith(`${path}:`)),
  };
}

/** A tool that "reads" lines 1 to 5 of whatever file it is asked for. */
function readingTool(evidence: ReadEvidence): AiTool {
  return {
    name: "read_file",
    description: "Reads a file.",
    inputSchema: { type: "object" },
    run(input) {
      const { path } = input as { path: string };
      for (let line = 1; line <= 5; line += 1) {
        evidence.addLine(path, line);
      }
      return Promise.resolve({ text: "FILE-TEXT", isRefused: false });
    },
  };
}

const readsOther: AiTurn = {
  text: "",
  toolCalls: [{ id: "1", name: "read_file", input: { path: "src/other.ts" } }],
  usage: { inputTokens: 100, outputTokens: 10 },
};

const finding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  message: "This can fail.",
  severity: "medium",
  ...overrides,
});

describe("a review with tools", () => {
  it("asks nothing when no changed file may be sent", async () => {
    const provider = createScriptedToolProvider([]);
    const evidence = createEvidence();

    const review = await reviewWithTools({
      provider,
      context: contextWith({ files: [addedFile(".env", "KEY=SECRET-CANARY")] }),
      tools: [],
      evidence,
    });

    expect(review).toEqual({
      status: "skipped",
      findings: [],
      suppressedFindingCount: 0,
      rejectedFindingCount: 0,
      sentFileCount: 0,
      omittedFileCount: 1,
      durationMs: 0,
      requestCount: 0,
      toolCallCount: 0,
    });
    expect(provider.turnRequests).toHaveLength(0);
    expect(evidence.lines.size).toBe(0);
  });

  it("sends fixed instructions and the pull request as one JSON document", async () => {
    const provider = createScriptedToolProvider([reply()]);

    await reviewWithTools({
      provider,
      context: contextWith({ title: "TITLE-CANARY" }),
      tools: [],
      evidence: createEvidence(),
    });

    const request = provider.turnRequests[0];
    expect(request?.system).toBe(TOOL_SYSTEM_PROMPT);
    expect(request?.system).not.toContain("CANARY");
    const first = request?.messages[0];
    const document = JSON.parse(first?.role === "user" ? first.text : "{}") as {
      pullRequest: { title: string };
      files: { path: string }[];
    };
    expect(document.pullRequest.title).toBe("TITLE-CANARY");
    expect(document.files.map((file) => file.path)).toEqual(["src/loader.ts"]);
  });

  it("keeps a finding only where the model was given the line", async () => {
    const evidence = createEvidence();
    const provider = createScriptedToolProvider([
      readsOther,
      {
        text: reply(
          finding({ message: "On a line of the diff.", filePath: "src/loader.ts", line: 2 }),
          finding({ message: "On a line a tool returned.", filePath: "src/other.ts", line: 4 }),
          finding({ message: "On a file a tool returned.", filePath: "src/other.ts" }),
          finding({ message: "About the whole pull request.", severity: "critical" }),
          finding({ message: "Beyond what was read.", filePath: "src/other.ts", line: 6 }),
          finding({ message: "In a file never opened.", filePath: "src/secret.ts", line: 1 }),
          finding({ message: "On a file never opened.", filePath: "src/secret.ts" }),
          finding({ message: "A line with no file.", line: 3 }),
          { message: "Malformed." },
        ),
        toolCalls: [],
        usage: { inputTokens: 200, outputTokens: 50 },
      },
    ]);

    const review = await reviewWithTools({
      provider,
      context: contextWith(),
      tools: [readingTool(evidence)],
      evidence,
    });

    expect(review).toMatchObject({
      status: "completed",
      stop: "answered",
      requestCount: 2,
      toolCallCount: 1,
      sentFileCount: 1,
      omittedFileCount: 0,
      rejectedFindingCount: 5,
      suppressedFindingCount: 0,
      usage: { inputTokens: 300, outputTokens: 60 },
    });
    expect(review.findings.map((entry) => entry.message).sort()).toEqual([
      "About the whole pull request.",
      "On a file a tool returned.",
      "On a line a tool returned.",
      "On a line of the diff.",
    ]);
    // The model decides none of these.
    for (const entry of review.findings) {
      expect(entry).toMatchObject({
        ruleId: "ai-review",
        confidence: 0.5,
        evidence: [
          { label: "Basis", value: "AI model suggestion about code it read, not verified" },
        ],
      });
      expect(entry.severity).not.toBe("critical");
    }
  });

  it("drops a suggestion at the place of a rule's finding, and applies the thresholds", async () => {
    const provider = createScriptedToolProvider([
      reply(
        finding({ message: "Same place as a rule.", filePath: "src/loader.ts", line: 1 }),
        finding({ message: "Low.", severity: "low", filePath: "src/loader.ts", line: 2 }),
        finding({ message: "High.", severity: "high", filePath: "src/loader.ts", line: 3 }),
      ),
    ]);
    const ruleFindings: ReviewFinding[] = [
      {
        ruleId: "a-rule",
        severity: "high",
        confidence: 1,
        message: "A rule found this.",
        evidence: [{ label: "L", value: "V" }],
        filePath: "src/loader.ts",
        line: 1,
      },
    ];

    const review = await reviewWithTools({
      provider,
      context: contextWith(),
      tools: [],
      evidence: createEvidence(),
      ruleFindings,
      thresholds: { minSeverity: "medium", minConfidence: 0 },
    });

    expect(review.findings.map((entry) => entry.message)).toEqual(["High."]);
    expect(review).toMatchObject({ suppressedFindingCount: 1, rejectedFindingCount: 1 });
  });

  it("fails without findings when the last reply is not the JSON that was asked for", async () => {
    const provider = createScriptedToolProvider(["I found nothing wrong."]);

    const review = await reviewWithTools({
      provider,
      context: contextWith(),
      tools: [],
      evidence: createEvidence(),
    });

    expect(review).toMatchObject({
      status: "failed",
      failureReason: "invalid-response",
      findings: [],
      requestCount: 1,
    });
    expect(review).not.toHaveProperty("stop");
  });

  it("fails by the provider's error name, and keeps what was counted", async () => {
    const evidence = createEvidence();
    const provider = createScriptedToolProvider([
      readsOther,
      () => Promise.reject(new ProviderHttpError(400)),
    ]);

    const review = await reviewWithTools({
      provider,
      context: contextWith(),
      tools: [readingTool(evidence)],
      evidence,
    });

    expect(review).toMatchObject({
      status: "failed",
      failureReason: "provider-error",
      errorName: "ProviderHttp400",
      requestCount: 2,
      toolCallCount: 1,
      usage: { inputTokens: 100, outputTokens: 10 },
    });
  });

  it("fails by time without an error name", async () => {
    const provider = createScriptedToolProvider([() => new Promise<AiTurn>(() => undefined)]);

    const review = await reviewWithTools({
      provider,
      context: contextWith(),
      tools: [],
      evidence: createEvidence(),
      limits: { timeoutMs: 10 },
    });

    expect(review).toMatchObject({ status: "failed", failureReason: "timeout" });
    expect(review).not.toHaveProperty("errorName");
  });

  it("says when a limit ended the search, and passes the caller's stop and clock on", async () => {
    const evidence = createEvidence();
    const times = [0, 1_500];
    const provider = createScriptedToolProvider([readsOther, reply()]);

    const review = await reviewWithTools({
      provider,
      context: contextWith(),
      tools: [readingTool(evidence)],
      evidence,
      shouldStop: () => true,
      now: () => times.shift() ?? 0,
    });

    expect(review).toMatchObject({ status: "completed", stop: "caller", durationMs: 1_500 });
    expect(provider.turnRequests[1]?.toolChoice).toBe("none");
  });
});
