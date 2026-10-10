import type { ReviewTrigger } from "@pr-buddy/github-client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createReviewService,
  type ReviewService,
} from "../../src/modules/reviews/review.service.js";
import { createDiscardingReviewStore } from "../../src/modules/reviews/review-store.js";
import {
  BASE_SHA,
  FakeGitHub,
  HEAD_SHA,
  httpError,
  NEWER_HEAD_SHA,
} from "../helpers/fake-github.js";
import { createRecordingLogger, type RecordingLogger } from "../helpers/recording-logger.js";
import {
  createRecordingReviewStore,
  type RecordingReviewStore,
} from "../helpers/recording-review-store.js";

const TRIGGER: ReviewTrigger = {
  action: "opened",
  installationId: 1001,
  repository: { id: 2002, owner: "acme", name: "widgets" },
  pullRequestNumber: 7,
};
const STARTED_AT = new Date("2026-10-10T10:00:00.000Z");
const COMPLETED_AT = new Date("2026-10-10T10:00:03.000Z");

let github: FakeGitHub;
let logger: RecordingLogger;
let reviewStore: RecordingReviewStore;
let service: ReviewService;

beforeEach(() => {
  github = new FakeGitHub();
  logger = createRecordingLogger();
  reviewStore = createRecordingReviewStore();
  const times = [STARTED_AT];
  service = createReviewService({
    clientFactory: github.clientFactory,
    logger,
    reviewStore,
    now: () => times.shift() ?? COMPLETED_AT,
  });
});

/** Makes the fake pull request trip two rules: no description, and source without tests. */
function makeReviewable(): void {
  github.pullRequest = { ...github.pullRequest, body: null, changedFileCount: 1 };
  github.files = [{ path: "src/feature.ts", status: "added", additions: 10, deletions: 0 }];
}

describe("review history", () => {
  it("records a completed review with what is needed to show it later", async () => {
    makeReviewable();

    await service.review(TRIGGER);

    expect(reviewStore.records).toHaveLength(1);
    const [record] = reviewStore.records;
    expect(record).toMatchObject({
      installationId: 1001,
      repository: { id: 2002, owner: "acme", name: "widgets" },
      pullRequestNumber: 7,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      outcome: {
        status: "completed",
        comment: "created",
        skippedFileCount: 0,
        omittedPatchCount: 0,
      },
    });
    expect(
      record?.outcome.status === "completed" ? record.outcome.result.findings : [],
    ).toHaveLength(2);
  });

  it("records a completed review that had nothing to report", async () => {
    await service.review(TRIGGER);

    expect(reviewStore.records[0]?.outcome).toMatchObject({ status: "completed", comment: "none" });
  });

  it.each([
    ["a draft", { isDraft: true }, "draft"],
    ["a closed pull request", { state: "closed" as const }, "closed"],
  ])("records the skip of %s, with the commits it saw", async (_name, change, reason) => {
    github.pullRequest = { ...github.pullRequest, ...change };

    await service.review(TRIGGER);

    expect(reviewStore.records).toEqual([
      expect.objectContaining({
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        outcome: { status: "skipped", reason },
      }),
    ]);
  });

  it("records a stale review against the commit that was reviewed", async () => {
    makeReviewable();
    github.beforeCall = (method, callNumber) => {
      if (method === "getPullRequest" && callNumber === 2) {
        github.pullRequest = { ...github.pullRequest, headSha: NEWER_HEAD_SHA };
      }
    };

    await service.review(TRIGGER);

    expect(reviewStore.records[0]).toMatchObject({
      headSha: HEAD_SHA,
      outcome: { status: "skipped", reason: "stale" },
    });
  });

  it("records a failure by error name and status, never its message, and still raises it", async () => {
    makeReviewable();
    github.beforeCall = (method) => {
      if (method === "listPullRequestFiles") {
        throw httpError(403, "MESSAGE-CANARY Resource not accessible");
      }
    };

    await expect(service.review(TRIGGER)).rejects.toMatchObject({ status: 403 });

    expect(reviewStore.records).toEqual([
      expect.objectContaining({
        headSha: HEAD_SHA,
        outcome: { status: "failed", errorName: "Error", errorStatus: 403 },
      }),
    ]);
    expect(JSON.stringify(reviewStore.records)).not.toContain("MESSAGE-CANARY");
  });

  it("records a failure that happened before the pull request could be fetched", async () => {
    github.beforeCall = () => {
      throw new TypeError("fetch failed");
    };

    await expect(service.review(TRIGGER)).rejects.toThrow("fetch failed");

    expect(reviewStore.records[0]?.outcome).toEqual({ status: "failed", errorName: "TypeError" });
    expect(reviewStore.records[0]).not.toHaveProperty("headSha");
    expect(reviewStore.records[0]).not.toHaveProperty("baseSha");
  });

  it("records a failure whose thrown value is not an Error", async () => {
    github.beforeCall = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the service must survive this
      throw "not an error";
    };

    await expect(service.review(TRIGGER)).rejects.toBe("not an error");

    expect(reviewStore.records[0]?.outcome).toEqual({ status: "failed", errorName: "NonError" });
  });

  it("still completes and comments when the review cannot be saved", async () => {
    makeReviewable();
    reviewStore.failWith = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });

    const outcome = await service.review(TRIGGER);

    expect(outcome).toMatchObject({ status: "completed", comment: "created" });
    expect(github.ownComments).toHaveLength(1);
    expect(logger.entries.at(-1)).toEqual({
      level: "error",
      message: "Review could not be saved",
      fields: {
        repositoryId: 2002,
        pullRequestNumber: 7,
        errorName: "Error",
        errorMessage: "connection refused",
        errorCode: "ECONNREFUSED",
      },
    });
  });

  it("raises the original failure even when that failure cannot be saved either", async () => {
    reviewStore.failWith = new Error("database is down");
    github.beforeCall = () => {
      throw httpError(503);
    };

    await expect(service.review(TRIGGER)).rejects.toMatchObject({ status: 503 });
  });

  it("keeps no history when no store is given", async () => {
    const withoutStore = createReviewService({ clientFactory: github.clientFactory, logger });

    await expect(withoutStore.review(TRIGGER)).resolves.toMatchObject({ status: "completed" });
  });

  it("discards records in the store used when there is no database", async () => {
    const store = createDiscardingReviewStore();

    await expect(
      store.save({
        installationId: 1,
        repository: { id: 1, owner: "a", name: "b" },
        pullRequestNumber: 1,
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
        outcome: { status: "skipped", reason: "draft" },
      }),
    ).resolves.toBeUndefined();
  });
});
