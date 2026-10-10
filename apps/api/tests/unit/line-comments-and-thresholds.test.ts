import type { ReviewTrigger } from "@pr-buddy/github-client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createReviewService,
  type ReviewService,
} from "../../src/modules/reviews/review.service.js";
import { FakeGitHub, HEAD_SHA, httpError, NEWER_HEAD_SHA } from "../helpers/fake-github.js";
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

let github: FakeGitHub;
let logger: RecordingLogger;
let reviewStore: RecordingReviewStore;
let service: ReviewService;

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

beforeEach(() => {
  github = new FakeGitHub();
  logger = createRecordingLogger();
  reviewStore = createRecordingReviewStore();
  service = createReviewService({ clientFactory: github.clientFactory, logger, reviewStore });
});

describe("comments on lines", () => {
  it("places a comment on each flagged line, on the reviewed commit", async () => {
    addLines("export function load() {", "  console.log('here');", "  debugger;", "}");

    await service.review(TRIGGER);

    expect(
      github.lineComments.map(({ path, line, commitId }) => ({ path, line, commitId })),
    ).toEqual([
      { path: "src/service.ts", line: 2, commitId: HEAD_SHA },
      { path: "src/service.ts", line: 3, commitId: HEAD_SHA },
    ]);
    expect(github.lineComments[0]?.body).toContain("` debug-statements `");
    expect(github.calls.filter((call) => call === "createReviewWithComments")).toHaveLength(1);
  });

  it("also lists those findings in the summary comment", async () => {
    addLines("console.log('here');");

    await service.review(TRIGGER);

    expect(github.ownComments[0]?.body).toContain("- **Location:** ` src/service.ts `, line 1");
  });

  it("does not repeat a comment when the pull request is reviewed again", async () => {
    addLines("console.log('here');");
    await service.review(TRIGGER);
    const firstId = github.lineComments[0]?.id;

    await service.review(TRIGGER);
    await service.review(TRIGGER);

    expect(github.lineComments).toHaveLength(1);
    expect(github.lineComments[0]?.id).toBe(firstId);
    expect(github.calls.filter((call) => call === "createReviewWithComments")).toHaveLength(1);
  });

  it("removes a comment once the statement is gone", async () => {
    addLines("console.log('here');");
    await service.review(TRIGGER);

    addLines("const quiet = true;");
    github.pullRequest = { ...github.pullRequest, headSha: NEWER_HEAD_SHA };
    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ status: "completed", findingCount: 0 });
    expect(github.lineComments).toEqual([]);
  });

  it("moves a comment when the flagged line moves", async () => {
    addLines("console.log('here');");
    await service.review(TRIGGER);

    addLines("const first = 1;", "console.log('here');");
    github.pullRequest = { ...github.pullRequest, headSha: NEWER_HEAD_SHA };
    await service.review(TRIGGER);

    expect(github.lineComments.map(({ line, commitId }) => ({ line, commitId }))).toEqual([
      { line: 2, commitId: NEWER_HEAD_SHA },
    ]);
  });

  it("leaves comments written by people and other apps alone", async () => {
    github.lineComments = [
      {
        id: 1,
        byThisApp: false,
        commitId: HEAD_SHA,
        path: "src/service.ts",
        line: 1,
        body: "Why?",
      },
    ];
    addLines("const quiet = true;");

    await service.review(TRIGGER);

    expect(github.lineComments).toHaveLength(1);
    expect(github.calls).not.toContain("deleteReviewComment");
  });

  it("posts no review of line comments when no finding has a line", async () => {
    await service.review(TRIGGER);

    expect(github.calls).toContain("listOwnReviewComments");
    expect(github.calls).not.toContain("createReviewWithComments");
  });

  it("does not post line comments for a stale review", async () => {
    addLines("console.log('here');");
    github.beforeCall = (method, callNumber) => {
      if (method === "getPullRequest" && callNumber === 2) {
        github.pullRequest = { ...github.pullRequest, headSha: NEWER_HEAD_SHA };
      }
    };

    await service.review(TRIGGER);

    expect(github.lineComments).toEqual([]);
  });

  it.each(["listOwnReviewComments", "createReviewWithComments"] as const)(
    "keeps the review and its summary when %s fails",
    async (failingMethod) => {
      addLines("console.log('here');");
      github.beforeCall = (method) => {
        if (method === failingMethod) {
          throw httpError(422, "Unprocessable: line must be part of the diff");
        }
      };

      const outcome = await service.review(TRIGGER);

      expect(outcome).toMatchObject({ status: "completed", findingCount: 1, comment: "created" });
      expect(github.ownComments).toHaveLength(1);
      expect(reviewStore.records[0]?.outcome.status).toBe("completed");
      expect(logger.entries).toContainEqual({
        level: "warn",
        message: "Line comments could not be published",
        fields: {
          repositoryId: 2002,
          pullRequestNumber: 7,
          errorName: "Error",
          errorMessage: "Unprocessable: line must be part of the diff",
          status: 422,
        },
      });
    },
  );

  it("logs how many line comments it added and removed", async () => {
    addLines("console.log('here');", "console.log('there');");
    await service.review(TRIGGER);
    addLines("console.log('here');");
    github.pullRequest = { ...github.pullRequest, headSha: NEWER_HEAD_SHA };

    await service.review(TRIGGER);

    const completed = logger.entries.filter((entry) => entry.message === "Review completed");
    expect(completed[0]?.fields).toMatchObject({ lineCommentsCreated: 2, lineCommentsDeleted: 0 });
    expect(completed[1]?.fields).toMatchObject({ lineCommentsCreated: 0, lineCommentsDeleted: 1 });
  });
});

describe("new rules through the service", () => {
  it("flags a committed credential file as high severity", async () => {
    github.files = [
      { path: "config/.env.production", status: "added", additions: 4, deletions: 0 },
    ];

    await service.review(TRIGGER);

    expect(github.ownComments[0]?.body).toContain("### High · ` credential-files `");
    expect(github.ownComments[0]?.body).toContain("- **Location:** ` config/.env.production `");
  });

  it("flags a change to a workflow file", async () => {
    github.files = [
      { path: ".github/workflows/deploy.yml", status: "modified", additions: 2, deletions: 1 },
    ];

    await service.review(TRIGGER);

    expect(github.ownComments[0]?.body).toContain("### Medium · ` sensitive-file-changes `");
  });
});

describe("reporting thresholds from the repository", () => {
  beforeEach(() => {
    addLines("console.log('here');");
    github.pullRequest = { ...github.pullRequest, body: null };
  });

  it("hide low-severity findings and say how many were hidden", async () => {
    github.files = [
      ...github.files,
      { path: ".github/workflows/deploy.yml", status: "modified", additions: 2, deletions: 1 },
    ];
    github.setConfiguration({ report: { minSeverity: "medium" } });

    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ status: "completed", findingCount: 1 });
    const body = github.ownComments[0]?.body ?? "";
    expect(body).toContain("### Medium · ` sensitive-file-changes `");
    expect(body).not.toContain("` pr-description `");
    expect(body).toContain(
      "- 2 findings below this repository's reporting thresholds are not shown.",
    );
    expect(github.lineComments).toEqual([]);
  });

  it("hide findings below a minimum confidence", async () => {
    github.setConfiguration({ report: { minConfidence: 0.95 } });

    await service.review(TRIGGER);

    const body = github.ownComments[0]?.body ?? "";
    expect(body).toContain("` pr-description `");
    expect(body).not.toContain("` debug-statements `");
  });

  it("post nothing when everything is hidden and there is no earlier comment", async () => {
    github.setConfiguration({ report: { minSeverity: "critical" } });

    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ status: "completed", findingCount: 0, comment: "none" });
    expect(github.comments).toEqual([]);
  });

  it("record the hidden count with the review", async () => {
    github.setConfiguration({ report: { minSeverity: "critical" } });

    await service.review(TRIGGER);

    const { outcome } = reviewStore.records[0] ?? {};
    expect(outcome?.status === "completed" ? outcome.result.suppressedFindingCount : -1).toBe(2);
  });

  it("fall back to reporting everything when the thresholds are invalid", async () => {
    github.setConfiguration({ report: { minSeverity: "urgent" } });

    await service.review(TRIGGER);

    const body = github.ownComments[0]?.body ?? "";
    expect(body).toContain("**2 findings**");
    expect(body).toContain("is invalid, so default settings were used");
  });
});
