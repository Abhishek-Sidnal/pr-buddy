import type { PullRequestSnapshot } from "@pr-buddy/github-client";
import { describe, expect, it } from "vitest";
import { readAiInputs, readEnvironment } from "../../src/environment.js";
import { classifyRepush, countCodeLines, sameCommitGate, stateGate } from "../../src/gates.js";
import { readReviewedCommit, renderReviewedMarker } from "../../src/markers.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

const pullRequest = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  number: 7,
  title: "T",
  body: null,
  baseSha: SHA,
  headSha: OTHER_SHA,
  state: "open",
  isDraft: false,
  changedFileCount: 1,
  isFromFork: false,
  ...overrides,
});

describe("the marker for a reviewed commit", () => {
  it("is read back as it was written", () => {
    expect(readReviewedCommit(`text\n${renderReviewedMarker(SHA)}\n`)).toBe(SHA);
  });

  it("is hidden from a reader of the comment", () => {
    expect(renderReviewedMarker(SHA)).toMatch(/^<!-- .* -->$/);
  });

  it("takes the last one when a comment holds several", () => {
    const body = `${renderReviewedMarker(SHA)}\nfindings\n${renderReviewedMarker(OTHER_SHA)}\n`;

    expect(readReviewedCommit(body)).toBe(OTHER_SHA);
  });

  it.each([
    ["no comment", undefined],
    ["a comment without one", "## PR Buddy review"],
    ["a short commit ID", "<!-- pr-buddy:runner reviewed=abc1234 -->"],
    ["an upper-case commit ID", `<!-- pr-buddy:runner reviewed=${"A".repeat(40)} -->`],
    [
      "a commit ID with a letter that is not hexadecimal",
      `<!-- pr-buddy:runner reviewed=${"g".repeat(40)} -->`,
    ],
    ["a longer value", `<!-- pr-buddy:runner reviewed=${"a".repeat(41)} -->`],
    ["the hosted service's marker alone", "<!-- pr-buddy:summary -->"],
  ])("finds none in %s", (_name, body) => {
    expect(readReviewedCommit(body)).toBeUndefined();
  });
});

describe("gates on a pull request's state", () => {
  it("lets an open pull request that is ready through", () => {
    expect(stateGate(pullRequest())).toBeUndefined();
  });

  it("stops a closed or merged one, draft or not", () => {
    expect(stateGate(pullRequest({ state: "closed" }))).toBe("closed");
    expect(stateGate(pullRequest({ state: "closed", isDraft: true }))).toBe("closed");
  });

  it("stops a draft", () => {
    expect(stateGate(pullRequest({ isDraft: true }))).toBe("draft");
  });

  it("stops a commit that was already reviewed, and only that one", () => {
    expect(sameCommitGate(SHA, SHA)).toBe("same-commit");
    expect(sameCommitGate(OTHER_SHA, SHA)).toBeUndefined();
    expect(sameCommitGate(undefined, SHA)).toBeUndefined();
  });
});

describe("how much code a push changed", () => {
  it("counts added and removed lines of code, and not of documentation", () => {
    expect(
      countCodeLines([
        { path: "src/a.ts", additions: 10, deletions: 5 },
        { path: "apps/web/src/b.tsx", additions: 1, deletions: 0 },
        { path: "README.md", additions: 100, deletions: 0 },
        { path: "docs/guide/intro.txt", additions: 100, deletions: 0 },
        { path: "docs/diagram.svg", additions: 100, deletions: 0 },
        { path: "packages/x/CHANGELOG.md", additions: 100, deletions: 0 },
        { path: "LICENSE", additions: 100, deletions: 0 },
      ]),
    ).toBe(16);
  });

  it("counts a file that only looks like documentation by part of its name", () => {
    expect(countCodeLines([{ path: "src/docs-loader.ts", additions: 3, deletions: 0 }])).toBe(3);
    expect(countCodeLines([{ path: "src/md.ts", additions: 2, deletions: 0 }])).toBe(2);
  });

  it("is zero for no changes", () => {
    expect(countCodeLines([])).toBe(0);
  });

  it("classifies a push by what was reviewed before and how much changed", () => {
    expect(classifyRepush(undefined, undefined)).toEqual({ kind: "first-review" });
    expect(classifyRepush(undefined, [{ path: "a.ts", additions: 500, deletions: 0 }])).toEqual({
      kind: "first-review",
    });
    expect(classifyRepush(SHA, undefined)).toEqual({ kind: "unknown" });
    expect(classifyRepush(SHA, [])).toEqual({ kind: "small", codeLines: 0 });
    expect(classifyRepush(SHA, [{ path: "a.ts", additions: 49, deletions: 0 }])).toEqual({
      kind: "small",
      codeLines: 49,
    });
    expect(classifyRepush(SHA, [{ path: "a.ts", additions: 25, deletions: 25 }])).toEqual({
      kind: "large",
      codeLines: 50,
    });
  });
});

describe("reading the workflow's environment", () => {
  const EVENT = JSON.stringify({ pull_request: { number: 7, title: "TITLE-CANARY" } });
  const VARIABLES = {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "acme/widgets",
    GITHUB_EVENT_PATH: "/event.json",
    GITHUB_STEP_SUMMARY: "/summary.md",
    "INPUT_GITHUB-TOKEN": "ghs_TOKEN-CANARY",
  };
  const read = (
    overrides: Record<string, string | undefined> = {},
    event: string | (() => string) = EVENT,
  ): ReturnType<typeof readEnvironment> =>
    readEnvironment({ ...VARIABLES, ...overrides }, () =>
      typeof event === "string" ? event : event(),
    );

  it("takes the token, the repository and the pull request's number", () => {
    expect(read()).toEqual({
      ok: true,
      environment: {
        token: "ghs_TOKEN-CANARY",
        owner: "acme",
        repo: "widgets",
        pullRequestNumber: 7,
        summaryPath: "/summary.md",
        workspacePath: undefined,
        ai: { kind: "none" },
      },
    });
  });

  it("takes nothing else from the event", () => {
    const result = read();

    expect(JSON.stringify(result)).not.toContain("TITLE-CANARY");
  });

  it("works without a place for a job summary", () => {
    expect(read({ GITHUB_STEP_SUMMARY: undefined })).toMatchObject({
      ok: true,
      environment: { summaryPath: undefined },
    });
    expect(read({ GITHUB_STEP_SUMMARY: "" })).toMatchObject({
      environment: { summaryPath: undefined },
    });
  });

  it("refuses pull_request_target, and says why", () => {
    const result = read({ GITHUB_EVENT_NAME: "pull_request_target" });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.problem).toContain("pull_request_target");
    expect(result.ok ? "" : result.problem).toContain("secrets");
  });

  it.each(["push", "issue_comment", "workflow_dispatch", "schedule", undefined, ""])(
    "refuses the event %j",
    (eventName) => {
      expect(read({ GITHUB_EVENT_NAME: eventName }).ok).toBe(false);
    },
  );

  it.each<[string, Record<string, string | undefined>]>([
    ["no token", { "INPUT_GITHUB-TOKEN": undefined }],
    ["an empty token", { "INPUT_GITHUB-TOKEN": "" }],
    ["no repository", { GITHUB_REPOSITORY: undefined }],
    ["a repository that is only a name", { GITHUB_REPOSITORY: "widgets" }],
    ["a repository with a path in it", { GITHUB_REPOSITORY: "acme/widgets/extra" }],
    ["a repository that climbs out", { GITHUB_REPOSITORY: "../etc/passwd" }],
    ["a repository with a query", { GITHUB_REPOSITORY: "acme/widgets?x=1" }],
    ["no event file", { GITHUB_EVENT_PATH: undefined }],
  ])("refuses %s, without repeating any value", (_name, overrides) => {
    const result = read(overrides);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("CANARY");
    expect(JSON.stringify(result)).not.toContain("passwd");
  });

  it.each<[string, string | (() => string)]>([
    [
      "cannot be read",
      () => {
        throw new Error("ENOENT SECRET-CANARY");
      },
    ],
    ["is not JSON", "{ not json"],
    ["names no pull request", JSON.stringify({ action: "opened" })],
    ["has a number that is not one", JSON.stringify({ pull_request: { number: "7; rm -rf" } })],
    ["has a negative number", JSON.stringify({ pull_request: { number: -1 } })],
    ["has a fraction for a number", JSON.stringify({ pull_request: { number: 1.5 } })],
    ["is far too large", " ".repeat(6 * 1_024 * 1_024)],
  ])("refuses an event file that %s", (_name, event) => {
    const result = read({}, event);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });
});

describe("reading the AI provider from the Action's inputs", () => {
  it("finds none when no provider is named, as in a fork's pull request", () => {
    expect(readAiInputs({})).toEqual({ kind: "none" });
    // A secret that does not exist arrives as an empty input.
    expect(
      readAiInputs({ "INPUT_AI-PROVIDER": "", "INPUT_AI-MODEL": "m", "INPUT_AI-API-KEY": "" }),
    ).toEqual({ kind: "none" });
  });

  it("builds the settings of each kind of provider", () => {
    expect(
      readAiInputs({
        "INPUT_AI-PROVIDER": "anthropic",
        "INPUT_AI-MODEL": "model-1",
        "INPUT_AI-API-KEY": "KEY-CANARY",
        "INPUT_AI-BASE-URL": "",
      }),
    ).toMatchObject({
      kind: "configured",
      settings: { provider: "anthropic", model: "model-1", apiKey: "KEY-CANARY" },
    });
    expect(
      readAiInputs({
        "INPUT_AI-PROVIDER": "bedrock",
        "INPUT_AI-MODEL": "model-1",
        "INPUT_AWS-REGION": "us-east-1",
        "INPUT_AWS-ACCESS-KEY-ID": "AKIDEXAMPLEEXAMPLE00",
        "INPUT_AWS-SECRET-ACCESS-KEY": "SECRET-CANARY",
        "INPUT_AWS-SESSION-TOKEN": "TOKEN-CANARY",
      }),
    ).toMatchObject({
      kind: "configured",
      settings: { provider: "bedrock", region: "us-east-1", sessionToken: "TOKEN-CANARY" },
    });
    expect(
      readAiInputs({
        "INPUT_AI-PROVIDER": "azure",
        "INPUT_AI-MODEL": "deployment",
        "INPUT_AI-API-KEY": "KEY",
        "INPUT_AI-BASE-URL": "https://example.openai.azure.com/openai/v1/",
      }),
    ).toMatchObject({
      kind: "configured",
      settings: { baseUrl: "https://example.openai.azure.com/openai/v1" },
    });
  });

  it("names the inputs that are wrong, and never repeats a value", () => {
    const missingKey = readAiInputs({
      "INPUT_AI-PROVIDER": "anthropic",
      "INPUT_AI-MODEL": "model-1",
    });
    const several = readAiInputs({
      "INPUT_AI-PROVIDER": "bedrock",
      "INPUT_AI-MODEL": "bad model VALUE-CANARY",
      "INPUT_AI-API-KEY": "KEY-CANARY",
      "INPUT_AI-BASE-URL": "http://attacker.example/VALUE-CANARY",
    });
    const unknown = readAiInputs({ "INPUT_AI-PROVIDER": "VALUE-CANARY" });

    expect(missingKey).toEqual({ kind: "invalid", fields: ["ai-api-key"] });
    expect(several).toEqual({
      kind: "invalid",
      fields: ["ai-base-url", "ai-model", "aws-region"],
    });
    expect(unknown).toEqual({ kind: "invalid", fields: ["ai-model", "ai-provider"] });
    expect(JSON.stringify([missingKey, several, unknown])).not.toContain("CANARY");
  });

  it("is part of the environment, with the place of the checkout", () => {
    const result = readEnvironment(
      {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "acme/widgets",
        GITHUB_EVENT_PATH: "/event.json",
        GITHUB_WORKSPACE: "/github/workspace",
        "INPUT_GITHUB-TOKEN": "ghs_TOKEN",
        "INPUT_AI-PROVIDER": "openai",
        "INPUT_AI-MODEL": "model-1",
        "INPUT_AI-API-KEY": "KEY",
      },
      () => JSON.stringify({ pull_request: { number: 7 } }),
    );

    expect(result).toMatchObject({
      ok: true,
      environment: {
        workspacePath: "/github/workspace",
        ai: { kind: "configured", settings: { provider: "openai" } },
      },
    });
  });
});
