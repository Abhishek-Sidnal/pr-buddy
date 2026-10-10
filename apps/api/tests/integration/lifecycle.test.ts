import { signWebhookBody, type ReviewTrigger } from "@pr-buddy/github-client";
import { createReviewEngine } from "@pr-buddy/review-engine";
import type { Express } from "express";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { migrate } from "../../src/database/migrate.js";
import { createPostgresSessionStore } from "../../src/modules/auth/postgres-session-store.js";
import { createInMemoryDeliveryStore } from "../../src/modules/github/delivery-store.js";
import {
  createIdleInstallationStore,
  createPostgresInstallationStore,
} from "../../src/modules/github/installation-store.js";
import {
  createReviewErrorLogger,
  recoverPendingReviews,
} from "../../src/modules/github/webhook.router.js";
import {
  createForgetfulPendingReviewStore,
  createPostgresPendingReviewStore,
  type PendingReviewStore,
} from "../../src/modules/reviews/pending-review-store.js";
import { createPostgresReviewStore } from "../../src/modules/reviews/postgres-review-store.js";
import { deleteExpiredData } from "../../src/modules/reviews/retention.js";
import { createReviewQueue, type ReviewQueue } from "../../src/modules/reviews/review-queue.js";
import { createReviewService } from "../../src/modules/reviews/review.service.js";
import { BASE_SHA, FakeGitHub, HEAD_SHA, httpError } from "../helpers/fake-github.js";
import { createRecordingLogger, type RecordingLogger } from "../helpers/recording-logger.js";
import { createTestDatabase, type TestDatabase } from "../helpers/test-database.js";

const WEBHOOK_SECRET = "0123456789abcdef-webhook-secret";

const TRIGGER: ReviewTrigger = {
  action: "opened",
  installationId: 1001,
  repository: { id: 2002, owner: "acme", name: "widgets" },
  pullRequestNumber: 7,
};

let test: TestDatabase;
let github: FakeGitHub;
let logger: RecordingLogger;
let reviewQueue: ReviewQueue;
let pendingReviewStore: PendingReviewStore;
let app: Express;
let deliveryCounter = 0;

function buildQueue(maxWaiting = 10): ReviewQueue {
  return createReviewQueue({
    concurrency: 1,
    maxWaiting,
    onError: createReviewErrorLogger(logger),
  });
}

function buildApp(overrides: { withDatabase?: boolean; maxWaiting?: number } = {}): Express {
  reviewQueue = buildQueue(overrides.maxWaiting);
  return createApp({
    webhookSecret: WEBHOOK_SECRET,
    deliveryStore: createInMemoryDeliveryStore(),
    reviewQueue,
    reviewService: createReviewService({ clientFactory: github.clientFactory, logger }),
    logger,
    trustProxy: 0,
    webhookRateLimit: 1_000,
    ...(overrides.withDatabase === false
      ? {}
      : {
          pendingReviewStore,
          installationStore: createPostgresInstallationStore(test.database),
        }),
  });
}

function pullRequestEvent(number = 7): string {
  return JSON.stringify({
    action: "opened",
    number,
    installation: { id: 1001 },
    repository: { id: 2002, name: "widgets", owner: { login: "acme" } },
  });
}

function deliver(body: string, event = "pull_request", target: Express = app): Promise<Response> {
  deliveryCounter += 1;
  return request(target)
    .post("/webhooks/github")
    .set("content-type", "application/json")
    .set("x-github-event", event)
    .set(
      "x-github-delivery",
      `00000000-0000-4000-8000-${String(deliveryCounter).padStart(12, "0")}`,
    )
    .set("x-hub-signature-256", signWebhookBody(WEBHOOK_SECRET, body))
    .send(body);
}

const rows = async <Row>(sql: string): Promise<Row[]> => (await test.database.query<Row>(sql)).rows;
const count = async (table: string): Promise<number> =>
  Number((await rows<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))[0]?.n);

interface PendingRow {
  pull_request_number: number;
  generation: number;
  attempts: number;
}
const pendingRows = (): Promise<PendingRow[]> =>
  rows<PendingRow>(
    "SELECT pull_request_number, generation, attempts FROM pending_reviews ORDER BY pull_request_number",
  );

/** Stores one completed review for a repository of an installation, at a given age in days. */
async function seedReview(
  installationId: number,
  repositoryId: number,
  ageDays = 0,
): Promise<void> {
  const startedAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1_000 - 60_000);
  const result = await createReviewEngine().review({
    pullRequest: { number: 7, title: "T", body: null, baseSha: BASE_SHA, headSha: HEAD_SHA },
    files: [{ path: "src/feature.ts", status: "added", additions: 1, deletions: 0 }],
  });
  await createPostgresReviewStore(test.database).save({
    installationId,
    repository: {
      id: repositoryId,
      owner: `owner-${installationId}`,
      name: `repo-${repositoryId}`,
    },
    pullRequestNumber: 7,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    startedAt,
    completedAt: new Date(startedAt.getTime() + 1_000),
    outcome: {
      status: "completed",
      comment: "created",
      skippedFileCount: 0,
      omittedPatchCount: 0,
      result,
      aiReview: {
        provider: "example",
        model: "m",
        status: "completed",
        findingCount: 1,
        suppressedFindingCount: 0,
        rejectedFindingCount: 0,
        sentFileCount: 1,
        omittedFileCount: 0,
        durationMs: 10,
      },
    },
  });
}

beforeAll(async () => {
  test = await createTestDatabase();
  await migrate(test.database);
});

afterAll(async () => {
  await test.destroy();
});

beforeEach(async () => {
  await test.database.query("TRUNCATE repositories, sessions, pending_reviews CASCADE");
  github = new FakeGitHub();
  logger = createRecordingLogger();
  pendingReviewStore = createPostgresPendingReviewStore(test.database);
  app = buildApp();
});

describe("the pending-review store", () => {
  it("gives each request for a pull request the next generation, in one row", async () => {
    expect(await pendingReviewStore.add(TRIGGER)).toBe(1);
    expect(await pendingReviewStore.add({ ...TRIGGER, action: "synchronize" })).toBe(2);
    expect(await pendingReviewStore.add({ ...TRIGGER, pullRequestNumber: 8 })).toBe(1);

    expect(await pendingRows()).toEqual([
      { pull_request_number: 7, generation: 2, attempts: 0 },
      { pull_request_number: 8, generation: 1, attempts: 0 },
    ]);
  });

  it("forgets a request when its review finishes", async () => {
    const generation = await pendingReviewStore.add(TRIGGER);

    await pendingReviewStore.complete({ trigger: TRIGGER, generation });

    expect(await pendingRows()).toEqual([]);
  });

  it("keeps a request that was replaced while its review ran", async () => {
    const first = await pendingReviewStore.add(TRIGGER);
    await pendingReviewStore.add(TRIGGER);

    await pendingReviewStore.complete({ trigger: TRIGGER, generation: first });
    await pendingReviewStore.recordFailure({ trigger: TRIGGER, generation: first });

    expect(await pendingRows()).toEqual([{ pull_request_number: 7, generation: 2, attempts: 0 }]);
  });

  it("counts failures, and a new request starts the count again", async () => {
    const generation = await pendingReviewStore.add(TRIGGER);
    await pendingReviewStore.recordFailure({ trigger: TRIGGER, generation });
    await pendingReviewStore.recordFailure({ trigger: TRIGGER, generation });
    expect((await pendingRows())[0]?.attempts).toBe(2);

    await pendingReviewStore.add(TRIGGER);

    expect((await pendingRows())[0]).toMatchObject({ generation: 2, attempts: 0 });
  });

  it("returns what can be recovered, oldest first, exactly as it was requested", async () => {
    await pendingReviewStore.add({ ...TRIGGER, pullRequestNumber: 9, action: "synchronize" });
    await test.database.query(
      "UPDATE pending_reviews SET requested_at = now() - interval '1 hour'",
    );
    await pendingReviewStore.add(TRIGGER);

    expect(await pendingReviewStore.takeRecoverable()).toEqual([
      { generation: 1, trigger: { ...TRIGGER, pullRequestNumber: 9, action: "synchronize" } },
      { generation: 1, trigger: TRIGGER },
    ]);
  });

  it("drops requests that failed three times or are older than a day", async () => {
    for (const number of [1, 2, 3, 4]) {
      await pendingReviewStore.add({ ...TRIGGER, pullRequestNumber: number });
    }
    await test.database.query(
      "UPDATE pending_reviews SET attempts = 3 WHERE pull_request_number = 1",
    );
    await test.database.query(
      "UPDATE pending_reviews SET attempts = 2 WHERE pull_request_number = 2",
    );
    await test.database.query(
      "UPDATE pending_reviews SET requested_at = now() - interval '25 hours' WHERE pull_request_number = 3",
    );

    const recoverable = await pendingReviewStore.takeRecoverable();

    expect(recoverable.map(({ trigger }) => trigger.pullRequestNumber)).toEqual([2, 4]);
    expect((await pendingRows()).map((row) => row.pull_request_number)).toEqual([2, 4]);
  });

  it("stores a hostile repository name as data", async () => {
    const hostile = {
      ...TRIGGER,
      repository: { ...TRIGGER.repository, name: "x'; DROP TABLE reviews; --" },
    };

    await pendingReviewStore.add(hostile);

    expect((await pendingReviewStore.takeRecoverable())[0]?.trigger).toEqual(hostile);
    expect(await count("reviews")).toBe(0);
  });

  it("remembers nothing without a database", async () => {
    const store = createForgetfulPendingReviewStore();

    expect([await store.add(TRIGGER), await store.add(TRIGGER)]).toEqual([1, 2]);
    await store.complete({ trigger: TRIGGER, generation: 1 });
    await store.recordFailure({ trigger: TRIGGER, generation: 1 });
    expect(await store.takeRecoverable()).toEqual([]);
  });
});

describe("a review requested by a webhook", () => {
  it("is remembered before the webhook is acknowledged, and forgotten when it finishes", async () => {
    let seenWhileRunning: PendingRow[] = [];
    github.beforeCall = async (method) => {
      if (method === "getPullRequest" && seenWhileRunning.length === 0) {
        seenWhileRunning = await pendingRows();
      }
    };

    const response = await deliver(pullRequestEvent());
    await reviewQueue.onIdle();

    expect(response.status).toBe(202);
    expect(seenWhileRunning).toEqual([{ pull_request_number: 7, generation: 1, attempts: 0 }]);
    expect(await pendingRows()).toEqual([]);
  });

  it("stays remembered, with the failure counted, when the review fails", async () => {
    github.beforeCall = () => {
      throw httpError(502);
    };

    await deliver(pullRequestEvent());
    await reviewQueue.onIdle();

    expect(await pendingRows()).toEqual([{ pull_request_number: 7, generation: 1, attempts: 1 }]);
    expect(logger.entries.map((entry) => entry.message)).toContain("Review failed");
  });

  it("is not remembered when the queue is full", async () => {
    app = buildApp({ maxWaiting: 0 });

    const response = await deliver(pullRequestEvent());

    expect(response.status).toBe(503);
    expect(await pendingRows()).toEqual([]);
  });

  it("outlasts a review that was already running when a new push arrived", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    github.beforeCall = async (method) => {
      if (method === "getPullRequest") {
        calls += 1;
        if (calls === 1) {
          await held;
        }
      }
    };

    await deliver(pullRequestEvent());
    await deliver(pullRequestEvent());
    const duringFirst = await pendingRows();
    release();
    await reviewQueue.onIdle();

    expect(duringFirst).toEqual([{ pull_request_number: 7, generation: 2, attempts: 0 }]);
    expect(await pendingRows()).toEqual([]);
    expect(github.calls.filter((call) => call === "listPullRequestFiles")).toHaveLength(2);
  });

  it("works as before without a database", async () => {
    app = buildApp({ withDatabase: false });

    const response = await deliver(pullRequestEvent());
    await reviewQueue.onIdle();

    expect(response.status).toBe(202);
    expect(github.calls).toContain("listPullRequestFiles");
    expect(await pendingRows()).toEqual([]);
  });
});

describe("recovery at start-up", () => {
  const recover = (queue: ReviewQueue = reviewQueue): Promise<number> =>
    recoverPendingReviews({
      reviewQueue: queue,
      reviewService: createReviewService({ clientFactory: github.clientFactory, logger }),
      pendingReviewStore,
      logger,
    });

  it("runs the reviews that never finished, then forgets them", async () => {
    await pendingReviewStore.add(TRIGGER);
    await pendingReviewStore.add({ ...TRIGGER, pullRequestNumber: 8 });

    const queued = await recover();
    await reviewQueue.onIdle();

    expect(queued).toBe(2);
    expect(github.calls.filter((call) => call === "listPullRequestFiles")).toHaveLength(2);
    expect(await pendingRows()).toEqual([]);
    expect(logger.entries).toContainEqual({
      level: "info",
      message: "Recovered reviews that were requested before the last stop",
      fields: { found: 2, queued: 2 },
    });
  });

  it("says nothing when there is nothing to recover", async () => {
    expect(await recover()).toBe(0);
    expect(logger.entries).toEqual([]);
  });

  it("counts another failure for a review that fails again, and gives up after three", async () => {
    github.beforeCall = () => {
      throw httpError(404);
    };
    await pendingReviewStore.add(TRIGGER);

    for (let start = 1; start <= 4; start += 1) {
      const queue = buildQueue();
      await recover(queue);
      await queue.onIdle();
    }

    // Three attempts were made; the fourth start found the request dropped.
    expect(github.calls.filter((call) => call === "getPullRequest")).toHaveLength(3);
    expect(await pendingRows()).toEqual([]);
  });

  it("leaves what does not fit in the queue for the next start", async () => {
    await pendingReviewStore.add(TRIGGER);
    await pendingReviewStore.add({ ...TRIGGER, pullRequestNumber: 8 });
    const tiny = buildQueue(1);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    tiny.enqueue("busy", () => held);
    tiny.enqueue("waiting", () => Promise.resolve());

    const queued = await recover(tiny);
    release();
    await tiny.onIdle();

    expect(queued).toBe(0);
    expect(await pendingRows()).toHaveLength(2);
  });
});

describe("retention", () => {
  beforeEach(async () => {
    await seedReview(1001, 2002, 400);
    await seedReview(1001, 2002, 366);
    await seedReview(1001, 2002, 364);
    await seedReview(1001, 2002, 0);
  });

  it("deletes reviews older than the limit, with everything that hangs off them", async () => {
    const result = await deleteExpiredData(test.database, { retentionDays: 365 });

    expect(result.reviewsDeleted).toBe(2);
    expect(await count("reviews")).toBe(2);
    expect(await count("findings")).toBe(4);
    expect(await count("rule_executions")).toBe(14);
    expect(await count("ai_reviews")).toBe(2);
    // The repository itself stays.
    expect(await count("repositories")).toBe(1);
  });

  it("keeps everything when the limit is zero", async () => {
    const result = await deleteExpiredData(test.database, { retentionDays: 0 });

    expect(result.reviewsDeleted).toBe(0);
    expect(await count("reviews")).toBe(4);
  });

  it("works through more reviews than one batch holds", async () => {
    for (let index = 0; index < 5; index += 1) {
      await seedReview(1001, 2002, 500 + index);
    }

    const result = await deleteExpiredData(test.database, { retentionDays: 365, batchSize: 2 });

    expect(result.reviewsDeleted).toBe(7);
    expect(await count("reviews")).toBe(2);
  });

  it("is safe to run again", async () => {
    await deleteExpiredData(test.database, { retentionDays: 365 });

    expect(await deleteExpiredData(test.database, { retentionDays: 365 })).toEqual({
      reviewsDeleted: 0,
      sessionsDeleted: 0,
    });
  });

  it("deletes expired sessions and stale pending reviews, and keeps live ones", async () => {
    const sessions = createPostgresSessionStore(test.database);
    const live = await sessions.create({ userId: 1, login: "a", installationIds: [1001] });
    await sessions.create({ userId: 2, login: "b", installationIds: [1001] });
    await test.database.query(
      "UPDATE sessions SET created_at = now() - interval '9 hours', expires_at = now() - interval '1 hour' WHERE user_id = 2",
    );
    await pendingReviewStore.add(TRIGGER);
    await pendingReviewStore.add({ ...TRIGGER, pullRequestNumber: 8 });
    await test.database.query(
      "UPDATE pending_reviews SET requested_at = now() - interval '2 days' WHERE pull_request_number = 8",
    );

    const result = await deleteExpiredData(test.database, { retentionDays: 0 });

    expect(result.sessionsDeleted).toBe(1);
    expect(await sessions.find(live)).toBeDefined();
    expect((await pendingRows()).map((row) => row.pull_request_number)).toEqual([7]);
  });
});

describe("a change of installation", () => {
  const OURS = 1001;
  const THEIRS = 9009;
  let ourSession: string;
  let theirSession: string;
  let sharedSession: string;
  const sessions = (): ReturnType<typeof createPostgresSessionStore> =>
    createPostgresSessionStore(test.database);

  beforeEach(async () => {
    await seedReview(OURS, 2002);
    await seedReview(OURS, 2003);
    await seedReview(THEIRS, 3003);
    ourSession = await sessions().create({ userId: 1, login: "a", installationIds: [OURS] });
    theirSession = await sessions().create({ userId: 2, login: "b", installationIds: [THEIRS] });
    sharedSession = await sessions().create({
      userId: 3,
      login: "c",
      installationIds: [THEIRS, OURS],
    });
    await pendingReviewStore.add(TRIGGER);
    await pendingReviewStore.add({
      ...TRIGGER,
      installationId: THEIRS,
      repository: { id: 3003, owner: "x", name: "y" },
    });
  });

  const installationEvent = (action: string, id = OURS): string =>
    JSON.stringify({ action, installation: { id }, sender: { login: "SENDER-CANARY" } });
  const repositoryIds = async (): Promise<number[]> =>
    (await rows<{ id: string }>("SELECT id FROM repositories ORDER BY id")).map((row) =>
      Number(row.id),
    );

  it("deletes the history and ends the sessions when the app is uninstalled", async () => {
    const response = await deliver(installationEvent("deleted"), "installation");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "applied" });
    expect(await repositoryIds()).toEqual([3003]);
    expect(await count("reviews")).toBe(1);
    expect(await count("findings")).toBe(2);
    expect(await count("ai_reviews")).toBe(1);
    expect(await sessions().find(ourSession)).toBeUndefined();
    expect(await sessions().find(sharedSession)).toBeUndefined();
    expect(await sessions().find(theirSession)).toBeDefined();
    expect(await rows("SELECT installation_id FROM pending_reviews")).toEqual([
      { installation_id: String(THEIRS) },
    ]);
    expect(logger.entries.at(-1)).toMatchObject({
      message: "Installation changed",
      fields: { change: "removed", installationId: OURS, sessionsEnded: 2, repositoriesDeleted: 2 },
    });
    expect(logger.text()).not.toContain("CANARY");
  });

  it("ends the sessions and keeps the history when the installation is suspended", async () => {
    await deliver(installationEvent("suspend"), "installation");

    expect(await repositoryIds()).toEqual([2002, 2003, 3003]);
    expect(await count("reviews")).toBe(3);
    expect(await count("pending_reviews")).toBe(2);
    expect(await sessions().find(ourSession)).toBeUndefined();
    expect(await sessions().find(theirSession)).toBeDefined();
  });

  it("deletes only the repositories that were removed from the installation", async () => {
    const body = JSON.stringify({
      action: "removed",
      installation: { id: OURS },
      repositories_removed: [
        { id: 2003, name: "gone" },
        { id: 3003, name: "not-theirs-to-remove" },
      ],
    });

    await deliver(body, "installation_repositories");

    // 3003 belongs to another installation, so this event cannot touch it.
    expect(await repositoryIds()).toEqual([2002, 3003]);
    expect(await sessions().find(ourSession)).toBeUndefined();
    expect(await sessions().find(theirSession)).toBeDefined();
    expect(await count("pending_reviews")).toBe(2);
  });

  it("removes nothing more when the same event is delivered again", async () => {
    await deliver(installationEvent("deleted"), "installation");
    const again = await deliver(installationEvent("deleted"), "installation");

    expect(again.status).toBe(200);
    expect(await repositoryIds()).toEqual([3003]);
    expect(logger.entries.at(-1)?.fields).toMatchObject({
      sessionsEnded: 0,
      repositoriesDeleted: 0,
    });
  });

  it.each([
    ["installation", installationEvent("created")],
    ["installation", installationEvent("unsuspend")],
    ["installation", installationEvent("new_permissions_accepted")],
    ["installation", JSON.stringify({ action: "deleted" })],
    ["installation", JSON.stringify({ action: "deleted", installation: { id: "1001 OR 1=1" } })],
    ["installation", "not json"],
    [
      "installation_repositories",
      JSON.stringify({ action: "added", installation: { id: OURS }, repositories_removed: [] }),
    ],
    [
      "installation_repositories",
      JSON.stringify({ action: "removed", installation: { id: OURS }, repositories_removed: [] }),
    ],
    [
      "installation_repositories",
      JSON.stringify({ action: "removed", installation: { id: OURS } }),
    ],
  ])("changes nothing for %s %s", async (event, body) => {
    const response = await deliver(body, event);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: "ignored", reason: "unsupported-action" });
    expect(await repositoryIds()).toEqual([2002, 2003, 3003]);
    expect(await sessions().find(ourSession)).toBeDefined();
  });

  it("refuses an installation event that is not signed", async () => {
    const response = await request(app)
      .post("/webhooks/github")
      .set("content-type", "application/json")
      .set("x-github-event", "installation")
      .set("x-github-delivery", "00000000-0000-4000-8000-999999999999")
      .set("x-hub-signature-256", `sha256=${"0".repeat(64)}`)
      .send(installationEvent("deleted"));

    expect(response.status).toBe(401);
    expect(await repositoryIds()).toEqual([2002, 2003, 3003]);
  });

  it("acknowledges the event and does nothing without a database", async () => {
    const response = await deliver(
      installationEvent("deleted"),
      "installation",
      buildApp({ withDatabase: false }),
    );

    expect(response.status).toBe(200);
    expect(await repositoryIds()).toEqual([2002, 2003, 3003]);
    expect(
      await createIdleInstallationStore().apply({ kind: "removed", installationId: OURS }),
    ).toEqual({
      sessionsEnded: 0,
      repositoriesDeleted: 0,
    });
  });
});
