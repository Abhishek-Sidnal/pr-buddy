import { createReviewEngine, type ReviewFinding, type ReviewResult } from "@pr-buddy/review-engine";
import { beforeAll, describe, expect, it } from "vitest";
import { renderFailureSummary, renderJobSummary } from "../../src/job-summary.js";
import type { ToolReview } from "@pr-buddy/ai-reviewer";
import type { AiSkipReason } from "../../src/ai-step.js";
import type { RunOutcome } from "../../src/run.js";

const HEAD_SHA = "b".repeat(40);
let clean: ReviewResult;
let withFinding: ReviewResult;

beforeAll(async () => {
  const engine = createReviewEngine();
  const files = [
    { path: "src/feature.ts", status: "added" as const, additions: 1, deletions: 0 },
    { path: "src/feature.test.ts", status: "added" as const, additions: 1, deletions: 0 },
  ];
  const pullRequest = { number: 7, title: "T", baseSha: "a".repeat(40), headSha: HEAD_SHA };
  clean = await engine.review({
    pullRequest: { ...pullRequest, body: "Explains the change and how it was tested, at length." },
    files,
  });
  withFinding = await engine.review({ pullRequest: { ...pullRequest, body: null }, files });
});

type Reviewed = Extract<RunOutcome, { kind: "reviewed" }>;
const reviewed = (overrides: Partial<Reviewed> = {}): Reviewed => ({
  kind: "reviewed",
  result: withFinding,
  comment: "created",
  repush: { kind: "first-review" },
  ai: { kind: "skipped", reason: "not-enabled" },
  isFromFork: false,
  skippedFileCount: 0,
  omittedPatchCount: 0,
  unlistedFileCount: 0,
  ...overrides,
});

const finding = (overrides: Partial<ReviewFinding>): ReviewFinding => ({
  ruleId: "pr-description",
  severity: "low",
  confidence: 1,
  message: "A message.",
  evidence: [{ label: "L", value: "V" }],
  ...overrides,
});

describe("the job summary of a run that reviewed", () => {
  it("says which commit, how many rules and how many findings", () => {
    const summary = renderJobSummary(reviewed());

    expect(summary.startsWith("## PR Buddy\n")).toBe(true);
    expect(summary).toContain("Reviewed commit ` bbbbbbb `");
    expect(summary).toMatch(/with \d+ rules: \*\*1 finding\*\*\./);
  });

  it("lists the findings in a table, so that they are there when no comment could be written", () => {
    const summary = renderJobSummary(reviewed({ comment: "not-permitted" }));

    expect(summary).toContain("| Severity | Rule | Where | Finding |");
    expect(summary).toContain("` pr-description `");
    expect(summary).toContain("comes from a fork");
  });

  it.each<[Reviewed["comment"], string]>([
    ["created", "A summary comment was posted"],
    ["updated", "The summary comment on the pull request was updated."],
    ["none", "No comment was posted: there are no findings"],
  ])("says what became of the comment: %s", (comment, text) => {
    expect(renderJobSummary(reviewed({ comment }))).toContain(text);
  });

  it("has no table when there is nothing to list", () => {
    const summary = renderJobSummary(reviewed({ result: clean, comment: "none" }));

    expect(summary).toContain("**0 findings**");
    expect(summary).not.toContain("| Severity |");
  });

  it("says that no model was asked", () => {
    expect(renderJobSummary(reviewed())).toContain("No AI model was asked: ");
  });

  it.each<[Reviewed["repush"], string | undefined]>([
    [{ kind: "first-review" }, undefined],
    [{ kind: "unknown" }, "could not be measured"],
    [{ kind: "small", codeLines: 1 }, "1 code line changed since the last review, fewer than 50."],
    [{ kind: "large", codeLines: 120 }, "120 code lines changed since the last review."],
  ])("says how much changed since the last review: %j", (repush, text) => {
    const summary = renderJobSummary(reviewed({ repush }));

    if (text === undefined) {
      expect(summary).not.toContain("since the last review");
    } else {
      expect(summary).toContain(text);
    }
  });

  it("says what could not be looked at", () => {
    const summary = renderJobSummary(
      reviewed({ skippedFileCount: 1, omittedPatchCount: 2, unlistedFileCount: 3 }),
    );

    expect(summary).toContain("3 files beyond the limit were not looked at.");
    expect(summary).toContain("2 files had a diff too large to read.");
    expect(summary).toContain("1 file had a path that could not be handled safely.");
  });

  it("says when rules failed and when findings were held back", () => {
    const result: ReviewResult = {
      ...clean,
      suppressedFindingCount: 4,
      rules: clean.rules.map((rule, index) => (index === 0 ? { ...rule, status: "failed" } : rule)),
    };

    const summary = renderJobSummary(reviewed({ result }));

    expect(summary).toContain("1 rule failed and reported nothing.");
    expect(summary).toContain("4 findings fell below the repository's reporting thresholds.");
  });

  it("shows where a finding is, with or without a line", () => {
    const result: ReviewResult = {
      ...withFinding,
      findings: [
        finding({ filePath: "src/a.ts", line: 12 }),
        finding({ filePath: "src/b.ts" }),
        finding({}),
      ],
    };

    const summary = renderJobSummary(reviewed({ result }));

    expect(summary).toContain("| ` src/a.ts:12 ` |");
    expect(summary).toContain("| ` src/b.ts ` |");
    expect(summary).toContain("| — |");
  });

  it("publishes what a contributor could choose as text, and keeps the table whole", () => {
    const result: ReviewResult = {
      ...withFinding,
      findings: [
        finding({
          filePath: "src/`x`|<img src=x onerror=alert(1)>.ts",
          message:
            "A | pipe, a <script>alert(1)</script>, a [link](https://evil.example)\nand a new line.",
        }),
      ],
    };

    const summary = renderJobSummary(reviewed({ result }));
    const row = summary.split("\n").find((line) => line.startsWith("| low |")) ?? "";

    expect(row).not.toContain("<script>");
    expect(row).not.toContain("](https://evil.example)");
    // Four cells: every pipe inside one is escaped or inside inline code.
    expect(
      row
        .replaceAll("\\|", "")
        .replaceAll(/`[^`]*`/g, "x")
        .split("|"),
    ).toHaveLength(6);
    expect(summary.split("\n").filter((line) => line.startsWith("| low |"))).toHaveLength(1);
  });

  it("lists at most fifty findings and counts the rest", () => {
    const result: ReviewResult = {
      ...withFinding,
      findings: Array.from({ length: 53 }, (_unused, index) =>
        finding({ message: `Finding ${String(index)}.` }),
      ),
    };

    const summary = renderJobSummary(reviewed({ result }));

    expect(summary.split("\n").filter((line) => line.startsWith("| low |"))).toHaveLength(50);
    expect(summary).toContain("3 more findings.");
  });
});

describe("the job summary of a run that did not review", () => {
  it("says that the base commit does not select runner mode, and how to select it", () => {
    const summary = renderJobSummary({ kind: "not-runner", issues: [] });

    expect(summary).toContain("Nothing was done.");
    expect(summary).toContain("` .github/pr-buddy.json `");
    expect(summary).toContain('"review": { "mode": "runner" }');
    expect(summary).not.toContain("is invalid");
  });

  it("says why an invalid file was not used, as text", () => {
    const summary = renderJobSummary({
      kind: "not-runner",
      issues: ["review.mode: Invalid option", "rules: <b>bad</b> [x](https://evil.example)"],
    });

    expect(summary).toContain("That file was not used, because it is invalid:");
    expect(summary).toContain("- review\\.mode: Invalid option");
    expect(summary).not.toContain("<b>bad</b>");
    expect(summary).not.toContain("](https://evil.example)");
  });

  it.each<[Extract<RunOutcome, { kind: "gated" }>["gate"], string]>([
    ["closed", "closed or merged"],
    ["draft", "is a draft"],
    ["same-commit", "This commit was already reviewed"],
  ])("names the gate that stopped it: %s", (gate, text) => {
    expect(renderJobSummary({ kind: "gated", gate })).toContain(text);
  });

  it("says when a newer commit took over", () => {
    expect(renderJobSummary({ kind: "superseded" })).toContain("A newer commit arrived");
  });

  it("says that a run failed, why, and that it published nothing", () => {
    const summary = renderFailureSummary("GitHub answered 403 (HttpError).");

    expect(summary).toContain("**The run failed.** GitHub answered 403 (HttpError).");
    expect(summary).toContain("Nothing was published on the pull request by this run.");
  });
});

describe("the job summary's account of the AI review", () => {
  const review = (overrides: Partial<ToolReview> = {}): ToolReview => ({
    status: "completed",
    stop: "answered",
    findings: [],
    suppressedFindingCount: 0,
    rejectedFindingCount: 0,
    sentFileCount: 2,
    omittedFileCount: 0,
    usage: { inputTokens: 12_345, outputTokens: 678 },
    durationMs: 41_400,
    requestCount: 4,
    toolCallCount: 6,
    ...overrides,
  });
  const asked = (overrides: Partial<ToolReview> = {}): Reviewed =>
    reviewed({
      ai: {
        kind: "asked",
        model: "anthropic/model-1",
        review: review(overrides),
        readFileCount: 3,
        readLineCount: 120,
      },
    });

  it.each<[AiSkipReason, string]>([
    ["not-enabled", "does not turn AI review on"],
    ["no-provider", "the workflow gave no AI provider"],
    ["invalid-provider", "are not valid"],
    ["too-large", "too large to load completely"],
    ["small-repush", "fewer than 50 code lines changed"],
    ["no-checkout", "Add a checkout step"],
    ["wrong-checkout", "github.event.pull_request.head.sha"],
  ])("says why no model was asked: %s", (reason, text) => {
    const summary = renderJobSummary(reviewed({ ai: { kind: "skipped", reason } }));

    expect(summary).toContain("No AI model was asked: ");
    expect(summary).toContain(text);
  });

  it("names the inputs that are wrong, and never a value", () => {
    const summary = renderJobSummary(
      reviewed({
        ai: { kind: "skipped", reason: "invalid-provider", fields: ["ai-api-key", "ai-model"] },
      }),
    );

    expect(summary).toContain("Check: ` ai-api-key `, ` ai-model `.");
    expect(
      renderJobSummary(
        reviewed({ ai: { kind: "skipped", reason: "invalid-provider", fields: [] } }),
      ),
    ).not.toContain("Check:");
  });

  it("says what a completed review cost and found", () => {
    const summary = renderJobSummary(
      asked({ findings: [finding({ ruleId: "ai-review", filePath: "src/a.ts", line: 3 })] }),
    );

    expect(summary).toContain("AI review by ` anthropic/model-1 `: **1 suggestion**.");
    expect(summary).toContain(
      "4 requests, 6 tool calls, 120 lines of 3 files given to it, 41 s. 12,345 input and 678 output tokens.",
    );
    expect(summary).toContain("| Severity | Where | AI suggestion |");
    expect(summary).toContain("| low | ` src/a.ts:3 ` | A message\\. |");
  });

  it("says what was dropped, and when a limit ended the reading", () => {
    const summary = renderJobSummary(asked({ rejectedFindingCount: 2, stop: "steps" }));

    expect(summary).toContain("**0 suggestions**. 2 suggestions dropped:");
    expect(summary).toContain("It reached the limit on steps and was asked for its answer.");
    expect(summary).not.toContain("AI suggestion |");
    expect(renderJobSummary(asked({ stop: "tokens" }))).toContain("limit on tokens");
    expect(renderJobSummary(asked({ stop: "caller" }))).toContain("how much may be read");
  });

  it.each<[Partial<ToolReview>, string]>([
    [{ failureReason: "timeout" }, "it ran out of time"],
    [{ failureReason: "invalid-response" }, "its reply could not be used"],
    [{ failureReason: "provider-error", errorName: "ProviderHttp401" }, "(` ProviderHttp401 `)"],
    [{ failureReason: "provider-error" }, "(` Error `)"],
  ])("says that a review failed, and why: %j", (failure, text) => {
    const failed = review({ status: "failed", ...failure });
    const summary = renderJobSummary(
      reviewed({
        ai: { kind: "asked", model: "m/1", review: failed, readFileCount: 1, readLineCount: 1 },
      }),
    );

    expect(summary).toContain("**The AI review by ` m/1 ` could not be completed:**");
    expect(summary).toContain(text);
    expect(summary).toContain("The rules' result stands.");
    expect(summary).toContain("1 line of 1 file given to it");
  });

  it("says when nothing could be sent, and when the provider counts no tokens", () => {
    const uncounted = Object.fromEntries(
      Object.entries(review()).filter(([key]) => key !== "usage"),
    ) as unknown as ToolReview;
    const nothing = renderJobSummary(asked({ status: "skipped" }));
    const noCounts = renderJobSummary(
      reviewed({
        ai: { kind: "asked", model: "m/1", review: uncounted, readFileCount: 2, readLineCount: 9 },
      }),
    );

    expect(nothing).toContain("no changed file could be sent to ` anthropic/model-1 `");
    expect(noCounts).toContain("The provider reported no token counts.");
  });
});
