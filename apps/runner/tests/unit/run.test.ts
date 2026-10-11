import { SUMMARY_MARKER } from "@pr-buddy/github-client";
import { beforeEach, describe, expect, it } from "vitest";
import { renderReviewedMarker } from "../../src/markers.js";
import { ModeUnknownError, runReview, type RunOutcome } from "../../src/run.js";
import {
  BASE_SHA,
  FakeRepository,
  HEAD_SHA,
  httpError,
  NEWER_SHA,
  OLDER_SHA,
} from "../helpers/fake-repository.js";

let repository: FakeRepository;

const run = (): Promise<RunOutcome> =>
  runReview({ client: repository.client, pullRequestNumber: 7 });

/** A summary comment the runner left for a commit. */
function leaveComment(reviewedSha: string, text = "an earlier review"): void {
  repository.comments.push({
    id: repository.comments.length + 1,
    body: `${SUMMARY_MARKER}\n${text}\n\n${renderReviewedMarker(reviewedSha)}\n`,
    isOwn: true,
  });
}

const WRITES = [
  "createComment",
  "updateComment",
  "createReviewWithComments",
  "deleteReviewComment",
];
const wrote = (): string[] => repository.calls.filter((call) => WRITES.includes(call));

beforeEach(() => {
  repository = new FakeRepository();
});

describe("who reviews", () => {
  it("reads the mode from the base commit, and from nowhere else", async () => {
    await run();

    expect(repository.calls.filter((call) => call.startsWith("getFileText"))).toEqual([
      `getFileText .github/pr-buddy.json@${BASE_SHA}`,
    ]);
  });

  it.each<[string, () => void]>([
    ["there is no configuration file", () => (repository.configuration = { status: "missing" })],
    [
      "the file does not mention a mode",
      () => {
        repository.setConfiguration({ rules: {} });
      },
    ],
    [
      "the file says hosted",
      () => {
        repository.setConfiguration({ review: { mode: "hosted" } });
      },
    ],
  ])("does nothing when %s", async (_name, arrange) => {
    repository.makeFinding();
    arrange();

    expect(await run()).toEqual({ kind: "not-runner", issues: [] });
    expect(repository.calls).toEqual([
      "getPullRequest",
      `getFileText .github/pr-buddy.json@${BASE_SHA}`,
    ]);
  });

  it.each<[string, () => void]>([
    [
      "names a mode that does not exist",
      () => {
        repository.setConfiguration({ review: { mode: "both" } });
      },
    ],
    [
      "asks for runner mode but is broken elsewhere",
      () => {
        repository.setConfiguration({ review: { mode: "runner" }, rules: 7 });
      },
    ],
    [
      "asks for runner mode and is not JSON",
      () => (repository.configuration = { status: "found", text: '{"review":{"mode":"runner"}' }),
    ],
    ["is too large to read", () => (repository.configuration = { status: "too-large" })],
  ])("does nothing, and says why, when the file %s", async (_name, arrange) => {
    repository.makeFinding();
    arrange();

    const outcome = await run();

    expect(outcome.kind).toBe("not-runner");
    expect(outcome.kind === "not-runner" ? outcome.issues.length : 0).toBeGreaterThan(0);
    expect(wrote()).toEqual([]);
    expect(repository.calls).not.toContain("listPullRequestFiles");
  });

  it("fails without reviewing or publishing when the file cannot be fetched", async () => {
    repository.makeFinding();
    repository.failures.set("getFileText", httpError(500));

    await expect(run()).rejects.toBeInstanceOf(ModeUnknownError);
    expect(wrote()).toEqual([]);
    expect(repository.calls).not.toContain("listPullRequestFiles");
  });

  it("says nothing of GitHub's own words when the mode is unknown", async () => {
    repository.failures.set("getFileText", httpError(403));

    await expect(run()).rejects.toThrow("The review mode could not be established");
    await expect(run()).rejects.not.toThrow(/CANARY/);
  });
});

describe("gates", () => {
  it.each<[string, () => void, string]>([
    [
      "closed",
      () => (repository.pullRequest = { ...repository.pullRequest, state: "closed" }),
      "closed",
    ],
    [
      "a draft",
      () => (repository.pullRequest = { ...repository.pullRequest, isDraft: true }),
      "draft",
    ],
  ])(
    "stops for a pull request that is %s, before reading its files",
    async (_name, arrange, gate) => {
      repository.makeFinding();
      arrange();

      expect(await run()).toEqual({ kind: "gated", gate });
      expect(repository.calls).not.toContain("listPullRequestFiles");
      expect(repository.calls).not.toContain("getOwnComment");
      expect(wrote()).toEqual([]);
    },
  );

  it("stops when its own comment already names this commit", async () => {
    repository.makeFinding();
    leaveComment(HEAD_SHA);

    expect(await run()).toEqual({ kind: "gated", gate: "same-commit" });
    expect(repository.calls).not.toContain("listPullRequestFiles");
    expect(wrote()).toEqual([]);
  });

  it("publishes once when it runs twice for one commit", async () => {
    repository.makeFinding();

    const first = await run();
    const second = await run();

    expect(first.kind).toBe("reviewed");
    expect(second).toEqual({ kind: "gated", gate: "same-commit" });
    expect(repository.comments).toHaveLength(1);
    expect(wrote()).toEqual(["createComment"]);
  });

  it("is not stopped by a comment someone else wrote with the marker and this commit", async () => {
    repository.makeFinding();
    repository.comments.push({
      id: 1,
      body: `${SUMMARY_MARKER}\n${renderReviewedMarker(HEAD_SHA)}`,
      isOwn: false,
    });

    expect((await run()).kind).toBe("reviewed");
    expect(repository.comments[0]?.body).toBe(
      `${SUMMARY_MARKER}\n${renderReviewedMarker(HEAD_SHA)}`,
    );
    expect(repository.ownComments).toHaveLength(1);
  });
});

describe("a review", () => {
  it("posts one summary comment that names the commit it reviewed", async () => {
    repository.makeFinding();

    const outcome = await run();

    expect(outcome).toMatchObject({ kind: "reviewed", comment: "created", isFromFork: false });
    expect(repository.ownComments).toHaveLength(1);
    const body = repository.ownComments[0]?.body ?? "";
    expect(body.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(body).toContain("pr-description");
    expect(body.trimEnd().endsWith(renderReviewedMarker(HEAD_SHA))).toBe(true);
  });

  it("stays quiet on a pull request with nothing to report", async () => {
    repository.makeClean();

    const outcome = await run();

    expect(outcome).toMatchObject({ kind: "reviewed", comment: "none" });
    expect(outcome.kind === "reviewed" ? outcome.result.findings : undefined).toEqual([]);
    expect(repository.comments).toEqual([]);
  });

  it("updates its comment for a new commit, and does not add a second one", async () => {
    repository.makeFinding();
    leaveComment(OLDER_SHA);

    const outcome = await run();

    expect(outcome).toMatchObject({ kind: "reviewed", comment: "updated" });
    expect(repository.comments).toHaveLength(1);
    expect(repository.comments[0]?.body).toContain(renderReviewedMarker(HEAD_SHA));
    expect(repository.comments[0]?.body).not.toContain(OLDER_SHA);
  });

  it("corrects its comment when a new commit fixes what it found", async () => {
    repository.makeClean();
    leaveComment(OLDER_SHA, "1 finding");

    const outcome = await run();

    expect(outcome).toMatchObject({ kind: "reviewed", comment: "updated" });
    expect(repository.comments[0]?.body).toContain("No findings");
  });

  it("never changes a comment it did not write, whatever that comment holds", async () => {
    repository.makeFinding();
    const theirs = `${SUMMARY_MARKER}\nwritten by a person\n${renderReviewedMarker(OLDER_SHA)}`;
    repository.comments.push({ id: 1, body: theirs, isOwn: false });

    await run();

    expect(repository.comments[0]?.body).toBe(theirs);
    expect(repository.ownComments).toHaveLength(1);
  });

  it("does not post line comments, and deletes none", async () => {
    repository.makeFinding();

    await run();

    expect(repository.calls).not.toContain("createReviewWithComments");
    expect(repository.calls).not.toContain("deleteReviewComment");
  });

  it("applies the rules the base commit configures", async () => {
    repository.makeFinding();
    repository.setConfiguration({
      review: { mode: "runner" },
      rules: { "pr-description": { enabled: false } },
    });

    const outcome = await run();

    expect(outcome.kind === "reviewed" ? outcome.result.findings : undefined).toEqual([]);
  });

  it("reports what it could not look at", async () => {
    repository.pullRequest = { ...repository.pullRequest, changedFileCount: 5_000 };

    const outcome = await run();

    expect(outcome.kind === "reviewed" ? outcome.unlistedFileCount : 0).toBeGreaterThan(0);
  });

  it("does not publish a result for a commit that is no longer the head", async () => {
    repository.makeFinding();
    repository.beforeCall = (method, callNumber) => {
      if (method === "getPullRequest" && callNumber === 2) {
        repository.pullRequest = { ...repository.pullRequest, headSha: NEWER_SHA };
      }
    };

    expect(await run()).toEqual({ kind: "superseded" });
    expect(wrote()).toEqual([]);
  });

  it("does not publish when the pull request was closed while it ran", async () => {
    repository.makeFinding();
    repository.beforeCall = (method, callNumber) => {
      if (method === "getPullRequest" && callNumber === 2) {
        repository.pullRequest = { ...repository.pullRequest, state: "closed" };
      }
    };

    expect(await run()).toEqual({ kind: "superseded" });
    expect(wrote()).toEqual([]);
  });

  it("keeps its marker last, so text from the pull request cannot pass for it", async () => {
    repository.makeFinding();
    const forged = `<!-- pr-buddy:runner reviewed=${NEWER_SHA} -->`;
    repository.files = [
      { path: `src/${forged}.ts`, status: "added", additions: 400, deletions: 0 },
    ];

    await run();
    repository.pullRequest = { ...repository.pullRequest, headSha: NEWER_SHA };
    const next = await run();

    // The forged marker named the next commit. Had it been believed, this run would be gated.
    expect(next.kind).toBe("reviewed");
  });
});

describe("how much changed since the last review", () => {
  it("is not asked on a first review", async () => {
    repository.makeFinding();

    const outcome = await run();

    expect(outcome.kind === "reviewed" ? outcome.repush : undefined).toEqual({
      kind: "first-review",
    });
    expect(repository.calls.some((call) => call.startsWith("compareCommits"))).toBe(false);
  });

  it.each<[string, number, string]>([
    ["small", 49, "small"],
    ["large", 50, "large"],
  ])(
    "is %s for %i changed code lines, and the rules run either way",
    async (_name, lines, kind) => {
      repository.makeFinding();
      leaveComment(OLDER_SHA);
      repository.comparisons.set(`${OLDER_SHA}...${HEAD_SHA}`, [
        { path: "src/feature.ts", additions: lines, deletions: 0 },
        { path: "README.md", additions: 500, deletions: 100 },
      ]);

      const outcome = await run();

      expect(outcome.kind === "reviewed" ? outcome.repush : undefined).toEqual({
        kind,
        codeLines: lines,
      });
      expect(outcome).toMatchObject({ kind: "reviewed", comment: "updated" });
    },
  );

  it("is unknown when the two commits cannot be compared, as after a force-push", async () => {
    repository.makeFinding();
    leaveComment(OLDER_SHA);

    const outcome = await run();

    expect(outcome.kind === "reviewed" ? outcome.repush : undefined).toEqual({ kind: "unknown" });
    expect(repository.calls).toContain(`compareCommits ${OLDER_SHA}...${HEAD_SHA}`);
  });
});

describe("a pull request from a fork", () => {
  beforeEach(() => {
    repository.pullRequest = { ...repository.pullRequest, isFromFork: true };
    repository.makeFinding();
  });

  it("is reviewed with the rules, and the result kept when the comment is refused", async () => {
    repository.failures.set("createComment", httpError(403));

    const outcome = await run();

    expect(outcome).toMatchObject({ kind: "reviewed", comment: "not-permitted", isFromFork: true });
    expect(outcome.kind === "reviewed" ? outcome.result.findings.length : 0).toBe(1);
  });

  it("gets a comment when GitHub allows one", async () => {
    expect(await run()).toMatchObject({ kind: "reviewed", comment: "created" });
  });

  it("still fails for any refusal other than the one a fork explains", async () => {
    repository.failures.set("createComment", httpError(500));

    await expect(run()).rejects.toMatchObject({ status: 500 });
  });
});

describe("failures", () => {
  it("fails when the comment is refused for a pull request of the repository's own", async () => {
    repository.makeFinding();
    repository.failures.set("createComment", httpError(403));

    await expect(run()).rejects.toMatchObject({ status: 403 });
  });

  it.each(["getPullRequest", "listPullRequestFiles", "getOwnComment"] as const)(
    "fails, and writes nothing, when %s fails",
    async (method) => {
      repository.makeFinding();
      repository.failures.set(method, httpError(502));

      await expect(run()).rejects.toMatchObject({ status: 502 });
      expect(wrote()).toEqual([]);
    },
  );
});
