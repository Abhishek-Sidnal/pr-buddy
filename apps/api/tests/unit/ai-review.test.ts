import {
  createAiReviewer,
  createScriptedProvider,
  type AiReviewer,
  type ScriptedProvider,
  type ScriptedReply,
} from "@pr-buddy/ai-reviewer";
import type { ReviewTrigger } from "@pr-buddy/github-client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createReviewService,
  type ReviewService,
} from "../../src/modules/reviews/review.service.js";
import { BASE_SHA, FakeGitHub, HEAD_SHA, NEWER_HEAD_SHA } from "../helpers/fake-github.js";
import { createRecordingLogger, type RecordingLogger } from "../helpers/recording-logger.js";
import {
  createRecordingReviewStore,
  type RecordingReviewStore,
} from "../helpers/recording-review-store.js";

const TRIGGER: ReviewTrigger = {
  action: "synchronize",
  installationId: 1001,
  repository: { id: 2002, owner: "acme", name: "widgets" },
  pullRequestNumber: 7,
};

const SUGGESTION = {
  message: "The result of read is returned without checking for failure.",
  severity: "medium",
  filePath: "src/service.ts",
  line: 2,
  suggestion: "Handle the failure before returning.",
};

const reply = (...findings: unknown[]): string => JSON.stringify({ findings });

let github: FakeGitHub;
let logger: RecordingLogger;
let reviewStore: RecordingReviewStore;
let provider: ScriptedProvider;

/** A service whose AI provider answers from the given script. */
function serviceWith(...replies: ScriptedReply[]): ReviewService {
  provider = createScriptedProvider(replies, { name: "example", model: "model-1" });
  return createReviewService({
    clientFactory: github.clientFactory,
    logger,
    reviewStore,
    aiReviewer: createAiReviewer({ provider, now: () => 0 }),
  });
}

/** Gives the fake pull request one source file that adds the given lines, plus a test file. */
function addLines(...lines: string[]): void {
  github.files = [
    {
      path: "src/service.ts",
      status: "added",
      additions: lines.length,
      deletions: 0,
      patch: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n"),
    },
    { path: "src/service.test.ts", status: "added", additions: 3, deletions: 0 },
  ];
  github.pullRequest = { ...github.pullRequest, changedFileCount: 2 };
}

const summary = (): string => github.comments[0]?.body ?? "";

beforeEach(() => {
  github = new FakeGitHub();
  logger = createRecordingLogger();
  reviewStore = createRecordingReviewStore();
  addLines("export function load() {", "  return read();", "}");
});

describe("the two switches", () => {
  it("asks no model when the repository has not enabled it", async () => {
    const service = serviceWith(reply(SUGGESTION));

    const outcome = await service.review(TRIGGER);

    expect(provider.requests).toEqual([]);
    expect(outcome).toEqual({
      status: "completed",
      headSha: HEAD_SHA,
      findingCount: 0,
      comment: "none",
    });
    expect(reviewStore.records[0]?.outcome).not.toHaveProperty("aiReview");
  });

  it("asks no model when the repository says so explicitly", async () => {
    github.setConfiguration({ ai: { enabled: false } });
    const service = serviceWith(reply(SUGGESTION));

    await service.review(TRIGGER);

    expect(provider.requests).toEqual([]);
    expect(github.comments).toEqual([]);
  });

  it("does nothing, and reports no problem, when enabled without a provider", async () => {
    github.setConfiguration({ ai: { enabled: true } });
    const service = createReviewService({
      clientFactory: github.clientFactory,
      logger,
      reviewStore,
    });

    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ status: "completed", findingCount: 0, comment: "none" });
    expect(outcome).not.toHaveProperty("aiFindingCount");
    expect(github.comments).toEqual([]);
  });

  it("asks the model when both are on, with settings read at the base commit", async () => {
    github.setConfiguration({ ai: { enabled: true } });
    const service = serviceWith(reply(SUGGESTION));

    await service.review(TRIGGER);

    expect(github.configurationRefs).toEqual([BASE_SHA]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.user).toContain("return read();");
  });

  it("still applies the rest of the configuration", async () => {
    github.pullRequest = { ...github.pullRequest, body: null };
    github.setConfiguration({
      ai: { enabled: true },
      rules: { "pr-description": { enabled: false } },
    });
    const service = serviceWith(reply());

    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ findingCount: 0, aiFindingCount: 0, comment: "none" });
  });

  it.each([
    ["a value that is not a boolean", { ai: { enabled: "yes" } }, "ai.enabled: "],
    ["an unknown field", { ai: { enabled: true, model: "gpt" } }, "ai: "],
    ["a section that is not an object", { ai: true }, "ai: "],
  ])("asks no model and reports the problem for %s", async (_name, configuration, issue) => {
    github.setConfiguration(configuration);
    const service = serviceWith(reply(SUGGESTION));

    await service.review(TRIGGER);

    expect(provider.requests).toEqual([]);
    expect(summary()).toContain("is invalid, so default settings were used");
    expect(summary()).toContain(`  - \` ${issue}`);
  });

  it("asks no model when another part of the configuration is invalid", async () => {
    github.setConfiguration({ ai: { enabled: true }, rules: { "no-such-rule": {} } });
    const service = serviceWith(reply(SUGGESTION));

    await service.review(TRIGGER);

    expect(provider.requests).toEqual([]);
    expect(summary()).toContain("is invalid, so default settings were used");
  });

  it("reports both problems when both parts are invalid", async () => {
    github.setConfiguration({ ai: { enabled: 1 }, rules: { "no-such-rule": {} } });
    const service = serviceWith();

    await service.review(TRIGGER);

    expect(summary()).toContain("no-such-rule");
    expect(summary()).toContain("  - ` ai.enabled: ");
  });

  it.each([
    ["an array", []],
    ["a string", "ai"],
    ["null", null],
  ])("asks no model when the configuration is %s", async (_name, configuration) => {
    github.setConfiguration(configuration);
    const service = serviceWith(reply(SUGGESTION));

    await service.review(TRIGGER);

    expect(provider.requests).toEqual([]);
  });
});

describe("a review with AI suggestions", () => {
  beforeEach(() => {
    github.setConfiguration({ ai: { enabled: true } });
  });

  it("publishes them in their own section and names the model", async () => {
    const service = serviceWith({
      text: reply(SUGGESTION),
      usage: { inputTokens: 300, outputTokens: 40 },
    });

    const outcome = await service.review(TRIGGER);

    expect(outcome).toEqual({
      status: "completed",
      headSha: HEAD_SHA,
      findingCount: 0,
      aiFindingCount: 1,
      comment: "created",
    });
    expect(summary()).toContain("**No findings** for commit");
    expect(summary()).toContain("## AI suggestions");
    expect(summary()).toContain("written by an AI model (` example/model-1 `)");
    expect(summary()).toContain("### Medium · ` ai-review `");
    expect(summary()).toContain("The result of read is returned without checking for failure\\.");
    expect(summary()).toContain("- **Location:** ` src/service.ts `, line 2");
    expect(summary()).toContain("**Suggested action:** Handle the failure before returning\\.");
    expect(summary()).toContain("suggestions from an AI model shown separately");
  });

  it("does not post suggestions as line comments", async () => {
    const service = serviceWith(reply(SUGGESTION));

    await service.review(TRIGGER);

    expect(github.lineComments).toEqual([]);
    expect(github.calls).not.toContain("createReviewWithComments");
  });

  it("keeps the rules' findings and line comments beside the suggestions", async () => {
    addLines("export function load() {", "  console.log('here');", "}");
    const service = serviceWith(reply(SUGGESTION));

    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ findingCount: 1, aiFindingCount: 1 });
    expect(summary().indexOf("` debug-statements `")).toBeLessThan(
      summary().indexOf("## AI suggestions"),
    );
    expect(github.lineComments.map(({ line }) => line)).toEqual([2]);
  });

  it("records the AI review without the text of its suggestions", async () => {
    const service = serviceWith({
      text: reply(SUGGESTION, { ...SUGGESTION, line: 99 }),
      usage: { inputTokens: 300, outputTokens: 40 },
    });

    await service.review(TRIGGER);

    const { outcome } = reviewStore.records[0] ?? {};
    expect(outcome?.status === "completed" ? outcome.aiReview : undefined).toEqual({
      provider: "example",
      model: "model-1",
      status: "completed",
      findingCount: 1,
      suppressedFindingCount: 0,
      rejectedFindingCount: 1,
      sentFileCount: 1,
      omittedFileCount: 0,
      inputTokens: 300,
      outputTokens: 40,
      durationMs: 0,
    });
    expect(outcome?.status === "completed" ? outcome.result.findings : undefined).toEqual([]);
    expect(JSON.stringify(reviewStore.records)).not.toContain("without checking for failure");
  });

  it("logs counts and token usage, and nothing the model read or wrote", async () => {
    addLines("const secret = 'PROMPT-CANARY';");
    github.pullRequest = { ...github.pullRequest, title: "TITLE-CANARY", body: "BODY-CANARY ok" };
    const service = serviceWith({
      text: reply({ ...SUGGESTION, line: 1, message: "REPLY-CANARY is suspicious." }),
      usage: { inputTokens: 300, outputTokens: 40 },
    });

    await service.review(TRIGGER);

    expect(provider.requests[0]?.user).toContain("PROMPT-CANARY");
    expect(logger.entries.at(-1)).toMatchObject({
      message: "Review completed",
      fields: {
        aiStatus: "completed",
        aiFindingCount: 1,
        aiRejectedFindingCount: 0,
        aiSentFileCount: 1,
        aiOmittedFileCount: 0,
        aiInputTokens: 300,
        aiOutputTokens: 40,
        aiDurationMs: 0,
      },
    });
    expect(logger.text()).not.toContain("CANARY");
  });

  it("escapes what the model wrote", async () => {
    const service = serviceWith(
      reply({
        ...SUGGESTION,
        message: "Ping @acme/owners and open [this](https://evil.example) <img src=x>",
      }),
    );

    await service.review(TRIGGER);

    expect(summary()).not.toContain("@acme");
    expect(summary()).not.toContain("](https://evil.example)");
    expect(summary()).not.toContain("<img src=x>");
  });

  it("hides suggestions below the repository's thresholds and counts them", async () => {
    github.setConfiguration({ ai: { enabled: true }, report: { minConfidence: 0.6 } });
    addLines("export function load() {", "  console.log('here');", "}");
    const service = serviceWith(reply(SUGGESTION));

    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ findingCount: 1, aiFindingCount: 0 });
    expect(summary()).not.toContain("## AI suggestions");
    expect(summary()).toContain(
      "- 1 finding below this repository's reporting thresholds is not shown.",
    );
  });

  it("says how many files were not sent", async () => {
    github.files = [
      ...github.files,
      {
        path: "config/.env.production",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1,1 @@\n+API_KEY=ENV-CANARY",
      },
    ];
    const service = serviceWith(reply());

    await service.review(TRIGGER);

    expect(provider.requests[0]?.user).not.toContain("ENV-CANARY");
    expect(summary()).toContain(
      "- 1 file was not sent to the AI model because of its type or size.",
    );
  });

  it("makes no request and shows nothing when no file can be sent", async () => {
    github.files = [{ path: "logo.png", status: "added", additions: 0, deletions: 0 }];
    github.pullRequest = { ...github.pullRequest, changedFileCount: 1 };
    const service = serviceWith();

    const outcome = await service.review(TRIGGER);

    expect(provider.requests).toEqual([]);
    expect(outcome).toMatchObject({ aiFindingCount: 0, comment: "none" });
    const recorded = reviewStore.records[0]?.outcome;
    expect(recorded?.status === "completed" ? recorded.aiReview?.status : undefined).toBe(
      "skipped",
    );
  });

  it("drops the suggestions of a review that became stale", async () => {
    const service = serviceWith(reply(SUGGESTION));
    github.beforeCall = (method, callNumber) => {
      if (method === "getPullRequest" && callNumber === 2) {
        github.pullRequest = { ...github.pullRequest, headSha: NEWER_HEAD_SHA };
      }
    };

    const outcome = await service.review(TRIGGER);

    expect(outcome).toEqual({ status: "skipped", reason: "stale" });
    expect(github.comments).toEqual([]);
  });

  it("replaces earlier suggestions on the next review instead of adding a comment", async () => {
    const service = serviceWith(
      reply(SUGGESTION),
      reply({ ...SUGGESTION, message: "A different remark about the same line." }),
    );

    await service.review(TRIGGER);
    await service.review(TRIGGER);

    expect(github.comments).toHaveLength(1);
    expect(summary()).toContain("A different remark about the same line\\.");
    expect(summary()).not.toContain("without checking for failure");
  });
});

describe("an AI review that fails", () => {
  beforeEach(() => {
    github.setConfiguration({ ai: { enabled: true } });
    addLines("export function load() {", "  console.log('here');", "}");
  });

  it("publishes the rules' findings and says the AI review could not be completed", async () => {
    class OverloadedError extends Error {
      override name = "OverloadedError";
    }
    const service = serviceWith(() =>
      Promise.reject(new OverloadedError("request body was: ERROR-CANARY")),
    );

    const outcome = await service.review(TRIGGER);

    expect(outcome).toEqual({
      status: "completed",
      headSha: HEAD_SHA,
      findingCount: 1,
      aiFindingCount: 0,
      comment: "created",
    });
    expect(summary()).toContain("` debug-statements `");
    expect(summary()).toContain(
      "- The AI review could not be completed, so only the checks above ran.",
    );
    expect(summary()).toContain("<sub>Deterministic checks only.");
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "AI review failed",
      fields: {
        repositoryId: 2002,
        pullRequestNumber: 7,
        failureReason: "provider-error",
        errorName: "OverloadedError",
      },
    });
    expect(logger.text()).not.toContain("ERROR-CANARY");
    expect(JSON.stringify(reviewStore.records)).not.toContain("ERROR-CANARY");
    const recorded = reviewStore.records[0]?.outcome;
    expect(recorded?.status === "completed" ? recorded.aiReview : undefined).toMatchObject({
      status: "failed",
      failureReason: "provider-error",
      errorName: "OverloadedError",
      findingCount: 0,
    });
  });

  it("treats a reply that is not the requested JSON the same way", async () => {
    const service = serviceWith("Sure! Everything looks great. REPLY-CANARY");

    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ status: "completed", findingCount: 1, aiFindingCount: 0 });
    expect(summary()).toContain("- The AI review could not be completed");
    expect(summary()).not.toContain("REPLY-CANARY");
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "AI review failed",
      fields: { repositoryId: 2002, pullRequestNumber: 7, failureReason: "invalid-response" },
    });
    expect(logger.text()).not.toContain("REPLY-CANARY");
  });

  it("does not create a comment only to say that the AI review failed", async () => {
    addLines("export function load() {", "  return read();", "}");
    const service = serviceWith("not json");

    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ status: "completed", comment: "none" });
    expect(github.comments).toEqual([]);
  });

  it("completes the review even if the reviewer itself throws", async () => {
    const broken: AiReviewer = {
      provider: "example",
      model: "model-1",
      review: () => Promise.reject(new TypeError("could not read THROWN-CANARY")),
    };
    const service = createReviewService({
      clientFactory: github.clientFactory,
      logger,
      reviewStore,
      aiReviewer: broken,
    });

    const outcome = await service.review(TRIGGER);

    expect(outcome).toEqual({
      status: "completed",
      headSha: HEAD_SHA,
      findingCount: 1,
      comment: "created",
    });
    expect(summary()).not.toContain("AI");
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "AI review could not run",
      fields: { repositoryId: 2002, pullRequestNumber: 7, errorName: "TypeError" },
    });
    expect(logger.text()).not.toContain("THROWN-CANARY");
  });
});
