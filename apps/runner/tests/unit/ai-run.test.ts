import {
  createScriptedToolProvider,
  providerSettingsSchema,
  type AiTurn,
  type ScriptedToolProvider,
  type ScriptedTurn,
} from "@pr-buddy/ai-reviewer";
import { SUMMARY_MARKER } from "@pr-buddy/github-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiDependencies, AiOutcome } from "../../src/ai-step.js";
import type { AiInputs } from "../../src/environment.js";
import { renderReviewedMarker } from "../../src/markers.js";
import { runReview, type RunOutcome } from "../../src/run.js";
import { FakeRepository, HEAD_SHA, OLDER_SHA } from "../helpers/fake-repository.js";
import { createTempCheckout, removeTempCheckouts } from "../helpers/temp-checkout.js";

const CONFIGURED: AiInputs = {
  kind: "configured",
  settings: providerSettingsSchema.parse({
    provider: "anthropic",
    model: "model-1",
    apiKey: "KEY-CANARY",
  }),
};

const CHECKOUT_FILES = {
  "src/feature.ts": "export function total() {\n  return helper();\n}\n",
  "src/helper.ts": "export function helper() {\n  return undefined;\n}\n",
  ".env": "TOKEN=ENV-FILE-CANARY\n",
};

const reads = (path: string): AiTurn => ({
  text: "",
  toolCalls: [{ id: "call-1", name: "read_file", input: { path } }],
  usage: { inputTokens: 500, outputTokens: 20 },
});

const answer = (...findings: unknown[]): string => JSON.stringify({ findings });

let repository: FakeRepository;
let provider: ScriptedToolProvider;
let providersBuilt: number;

beforeEach(() => {
  repository = new FakeRepository();
  repository.setConfiguration({ review: { mode: "runner" }, ai: { enabled: true } });
  repository.files = [
    {
      path: "src/feature.ts",
      status: "added",
      additions: 3,
      deletions: 0,
      patch: "@@ -0,0 +1,3 @@\n+export function total() {\n+  return helper();\n+}",
    },
    { path: "src/feature.test.ts", status: "added", additions: 12, deletions: 0 },
  ];
  providersBuilt = 0;
});

afterEach(removeTempCheckouts);

/** Runs a review with a scripted model over a real folder. */
async function run(
  turns: readonly ScriptedTurn[],
  overrides: Partial<AiDependencies> = {},
): Promise<RunOutcome> {
  const { root } = await createTempCheckout(CHECKOUT_FILES);
  provider = createScriptedToolProvider(turns, { name: "anthropic", model: "model-1" });
  return runReview({
    client: repository.client,
    pullRequestNumber: 7,
    ai: {
      inputs: CONFIGURED,
      workspacePath: root,
      createProvider: () => {
        providersBuilt += 1;
        return provider;
      },
      ...overrides,
    },
  });
}

function aiOf(outcome: RunOutcome): AiOutcome {
  if (outcome.kind !== "reviewed") {
    throw new Error(`The run did not review: ${outcome.kind}`);
  }
  return outcome.ai;
}

const commentBody = (): string => repository.ownComments[0]?.body ?? "";

describe("a run that asks a model", () => {
  it("lets the model read the checkout and publishes only what it read", async () => {
    const outcome = await run([
      reads("src/helper.ts"),
      answer(
        {
          message: "The helper returns nothing, so total does too.",
          severity: "high",
          filePath: "src/helper.ts",
          line: 2,
        },
        { message: "Invented.", severity: "high", filePath: "src/unread.ts", line: 1 },
      ),
    ]);

    const ai = aiOf(outcome);
    expect(ai).toMatchObject({
      kind: "asked",
      model: "anthropic/model-1",
      review: {
        status: "completed",
        stop: "answered",
        requestCount: 2,
        toolCallCount: 1,
        rejectedFindingCount: 1,
      },
      // Three lines of the diff and three of the helper.
      readFileCount: 2,
      readLineCount: 6,
    });
    const body = commentBody();
    expect(body.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(body).toContain("## AI suggestions");
    expect(body).toContain("this pull request and the files of the repository it read");
    expect(body).toContain("The helper returns nothing, so total does too");
    expect(body).not.toContain("Invented");
    expect(body.trimEnd().endsWith(renderReviewedMarker(HEAD_SHA))).toBe(true);

    // The tool's answer went back to the model with the file's lines.
    const last = provider.turnRequests[1]?.messages.at(-1);
    expect(last?.role === "tool" && last.results[0]?.text).toBe(
      "src/helper.ts, lines 1 to 3 of 3:\n1: export function helper() {\n2:   return undefined;\n3: }",
    );
    expect(provider.turnRequests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "search",
      "list_files",
    ]);
  });

  it("never gives the model a credential file, Git's data or the key", async () => {
    const outcome = await run([
      {
        text: "",
        toolCalls: [
          { id: "1", name: "read_file", input: { path: ".env" } },
          { id: "2", name: "read_file", input: { path: ".git/config" } },
          { id: "3", name: "read_file", input: { path: "../../proc/self/environ" } },
          { id: "4", name: "search", input: { query: "TOKEN=" } },
        ],
      },
      answer({ message: "About the env file.", severity: "high", filePath: ".env", line: 1 }),
    ]);

    expect(aiOf(outcome)).toMatchObject({ review: { toolCallCount: 4, findings: [] } });
    const sent = JSON.stringify(provider.turnRequests);
    for (const canary of ["ENV-FILE-CANARY", "GIT-CONFIG-CANARY", "KEY-CANARY"]) {
      expect(sent).not.toContain(canary);
    }
  });

  it("posts a comment for AI suggestions alone, when the rules found nothing", async () => {
    const outcome = await run([
      answer({ message: "A problem.", severity: "medium", filePath: "src/feature.ts", line: 2 }),
    ]);

    expect(outcome).toMatchObject({ kind: "reviewed", comment: "created" });
    expect(outcome.kind === "reviewed" && outcome.result.findings).toHaveLength(0);
    expect(commentBody()).toContain("A problem");
  });

  it("stays quiet when neither the rules nor the model found anything", async () => {
    const outcome = await run([answer()]);

    expect(outcome).toMatchObject({ kind: "reviewed", comment: "none" });
    expect(repository.ownComments).toHaveLength(0);
  });

  it("publishes the rules' result when the provider fails, and does not fail the run", async () => {
    repository.makeFinding();

    const outcome = await run([() => Promise.reject(new Error("PROVIDER-MESSAGE-CANARY"))]);

    expect(aiOf(outcome)).toMatchObject({
      review: { status: "failed", failureReason: "provider-error", errorName: "Error" },
    });
    expect(outcome).toMatchObject({ kind: "reviewed", comment: "created" });
    expect(commentBody()).toContain("The AI review could not be completed");
    expect(JSON.stringify(outcome)).not.toContain("CANARY");
  });

  it("says in the comment when a limit ended the model's reading", async () => {
    const outcome = await run(
      [
        reads("src/helper.ts"),
        answer({ message: "Found.", severity: "low", filePath: "src/helper.ts", line: 1 }),
      ],
      { limits: { maxSteps: 1 } },
    );

    expect(aiOf(outcome)).toMatchObject({ review: { status: "completed", stop: "steps" } });
    expect(commentBody()).toContain("reached a limit on how much it may read");
  });
});

describe("a run that does not ask a model", () => {
  const expectSkipped = (outcome: RunOutcome, reason: string): void => {
    expect(aiOf(outcome)).toMatchObject({ kind: "skipped", reason });
    expect(providersBuilt).toBe(0);
  };

  it("when the repository has not turned AI review on", async () => {
    repository.setConfiguration({ review: { mode: "runner" } });
    repository.makeFinding();

    expectSkipped(await run([]), "not-enabled");
    expect(commentBody()).not.toContain("AI review did not run");
  });

  it("when the workflow gave no provider, as for a fork", async () => {
    expectSkipped(await run([], { inputs: { kind: "none" } }), "no-provider");
    expectSkipped(
      await runReview({ client: repository.client, pullRequestNumber: 7 }),
      "no-provider",
    );
  });

  it("when the provider's inputs are not valid, and says which", async () => {
    repository.makeFinding();

    const outcome = await run([], { inputs: { kind: "invalid", fields: ["ai-model"] } });

    expectSkipped(outcome, "invalid-provider");
    expect(aiOf(outcome)).toMatchObject({ fields: ["ai-model"] });
    expect(commentBody()).toContain("settings for the AI provider are not valid");
  });

  it("when part of the pull request could not be loaded", async () => {
    repository.makeFinding();
    repository.pullRequest = { ...repository.pullRequest, changedFileCount: 5_000 };

    expectSkipped(await run([]), "too-large");
    expect(commentBody()).toContain("too large to load completely");
  });

  it("when the push changed little since the last review, and still runs the rules", async () => {
    repository.makeFinding();
    repository.comments.push({
      id: 1,
      body: `${SUMMARY_MARKER}\nearlier\n\n${renderReviewedMarker(OLDER_SHA)}\n`,
      isOwn: true,
    });
    repository.comparisons.set(`${OLDER_SHA}...${HEAD_SHA}`, [
      { path: "src/feature.ts", additions: 3, deletions: 0 },
    ]);

    const outcome = await run([]);

    expectSkipped(outcome, "small-repush");
    expect(outcome).toMatchObject({ kind: "reviewed", comment: "updated" });
    expect(commentBody()).toContain("because it changed little since the last review");
    expect(commentBody()).toContain(renderReviewedMarker(HEAD_SHA));
  });

  it("when there is no checkout", async () => {
    repository.makeFinding();

    expectSkipped(await run([], { workspacePath: undefined }), "no-checkout");
    expect(commentBody()).toContain("does not check the repository out");
  });

  it("when the checkout is at another commit than the head", async () => {
    repository.makeFinding();
    repository.pullRequest = { ...repository.pullRequest, headSha: "e".repeat(40) };

    expectSkipped(await run([]), "wrong-checkout");
    expect(commentBody()).toContain("not at this pull request's latest commit");
  });
});
