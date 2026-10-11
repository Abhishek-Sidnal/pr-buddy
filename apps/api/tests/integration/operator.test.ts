import type { Express } from "express";
import request, { type Response as TestResponse } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { migrate } from "../../src/database/migrate.js";
import { createPostgresSessionStore } from "../../src/modules/auth/postgres-session-store.js";
import type { SessionStore } from "../../src/modules/auth/session-store.js";
import { createInMemoryDeliveryStore } from "../../src/modules/github/delivery-store.js";
import { createPostgresHistoryStore } from "../../src/modules/history/postgres-history-store.js";
import {
  createPostgresOperatorStore,
  MAX_INSTALLATIONS,
  type OperatorOverview,
} from "../../src/modules/operator/operator-store.js";
import { createReviewQueue, type ReviewQueue } from "../../src/modules/reviews/review-queue.js";
import { createReviewService } from "../../src/modules/reviews/review.service.js";
import { FakeGitHub } from "../helpers/fake-github.js";
import { createRecordingLogger, type RecordingLogger } from "../helpers/recording-logger.js";
import { createTestDatabase, type TestDatabase } from "../helpers/test-database.js";

const PUBLIC_URL = "http://localhost:3000";
const OPERATOR = 42;
const CUSTOMER = 77;

/** Two installations. Their names are canaries: none may reach the operator's view. */
const ACME = { installationId: 1001, repositoryId: 2002, owner: "acme", name: "REPO-CANARY-one" };
const RIVAL = { installationId: 9009, repositoryId: 3003, owner: "rival", name: "REPO-CANARY-two" };

type Overview = OperatorOverview & {
  generatedAt: string;
  queue: { running: number; waiting: number };
};

let test: TestDatabase;
let logger: RecordingLogger;
let sessions: SessionStore;
let reviewQueue: ReviewQueue;
let app: Express;
let operatorCookie: string;
let customerCookie: string;

function buildApp(operatorUserIds: readonly number[] | null = [OPERATOR]): Express {
  reviewQueue = createReviewQueue({ concurrency: 1, maxWaiting: 5, onError: () => undefined });
  return createApp({
    webhookSecret: "0123456789abcdef-webhook-secret",
    deliveryStore: createInMemoryDeliveryStore(),
    reviewQueue,
    reviewService: createReviewService({ clientFactory: new FakeGitHub().clientFactory, logger }),
    logger,
    trustProxy: 0,
    webhookRateLimit: 1_000,
    dashboard: {
      authClient: { authorizeUrl: () => "", signIn: () => Promise.reject(new Error("unused")) },
      sessionStore: sessions,
      historyStore: createPostgresHistoryStore(test.database),
      publicUrl: PUBLIC_URL,
      webRoot: "/nonexistent",
      authRateLimit: 1_000,
      apiRateLimit: 1_000,
      ...(operatorUserIds === null
        ? {}
        : {
            operatorView: {
              operatorStore: createPostgresOperatorStore(test.database),
              operatorUserIds,
            },
          }),
    },
  });
}

async function signInAs(userId: number, installationIds: number[]): Promise<string> {
  const token = await sessions.create({
    userId,
    login: `LOGIN-CANARY-${userId}`,
    installationIds,
    installations: installationIds.map((id) => ({
      id,
      account: `account-${id}`,
      isOwner: true,
    })),
  });
  return `prbuddy_session=${token}`;
}

const get = (path: string, cookie: string | null = operatorCookie): Promise<TestResponse> => {
  const call = request(app).get(path);
  return cookie === null ? call : call.set("Cookie", cookie);
};

const overview = async (): Promise<Overview> =>
  (await get("/api/operator/overview")).body as Overview;

async function seedRepository(repository: typeof ACME): Promise<void> {
  await test.database.query(
    "INSERT INTO repositories (id, installation_id, owner, name) VALUES ($1, $2, $3, $4)",
    [repository.repositoryId, repository.installationId, repository.owner, repository.name],
  );
}

/** Stores a review that started `ageHours` ago. Returns its ID. */
async function seedReview(
  repositoryId: number,
  status: "completed" | "skipped" | "failed",
  ageHours: number,
): Promise<string> {
  const result = await test.database.query<{ id: string }>(
    `INSERT INTO reviews
       (repository_id, pull_request_number, status, skip_reason, comment_action, error_name,
        started_at, completed_at)
     VALUES ($1, 4242, $2, $3, $4, $5,
             now() - make_interval(hours => $6), now() - make_interval(hours => $6))
     RETURNING id`,
    [
      repositoryId,
      status,
      status === "skipped" ? "draft" : null,
      status === "completed" ? "created" : null,
      status === "failed" ? "ERROR-CANARY" : null,
      ageHours,
    ],
  );
  return result.rows[0]?.id ?? "";
}

async function seedAiReview(
  reviewId: string,
  status: "completed" | "skipped" | "failed",
): Promise<void> {
  await test.database.query(
    `INSERT INTO ai_reviews (review_id, provider, model, status, failure_reason, duration_ms)
     VALUES ($1, 'anthropic', 'MODEL-CANARY', $2, $3, 10)`,
    [reviewId, status, status === "failed" ? "timeout" : null],
  );
}

beforeAll(async () => {
  test = await createTestDatabase();
  await migrate(test.database);
});

afterAll(async () => {
  await test.destroy();
});

beforeEach(async () => {
  await test.database.query(
    "TRUNCATE repositories, sessions, pending_reviews, installation_ai_keys CASCADE",
  );
  logger = createRecordingLogger();
  sessions = createPostgresSessionStore(test.database);
  app = buildApp();
  operatorCookie = await signInAs(OPERATOR, [ACME.installationId]);
  customerCookie = await signInAs(CUSTOMER, [RIVAL.installationId]);
});

describe("who may see the operator's view", () => {
  it("answers the operator", async () => {
    const response = await get("/api/operator/overview");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("answers anyone else exactly as it answers for a path that does not exist", async () => {
    const hidden = await get("/api/operator/overview", customerCookie);
    const missing = await get("/api/no-such-thing", customerCookie);

    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(hidden.headers["content-type"]).toBe(missing.headers["content-type"]);
  });

  it("needs a session", async () => {
    expect((await get("/api/operator/overview", null)).status).toBe(401);
  });

  it("hides every path under it from someone who is not the operator", async () => {
    for (const path of ["/api/operator", "/api/operator/", "/api/operator/anything/else"]) {
      expect((await get(path, customerCookie)).status).toBe(404);
    }
    expect((await get("/api/operator/anything", operatorCookie)).status).toBe(404);
  });

  it("does not exist when no operator is configured", async () => {
    app = buildApp(null);
    expect((await get("/api/operator/overview")).status).toBe(404);

    app = buildApp([]);
    expect((await get("/api/operator/overview")).status).toBe(404);
  });

  it("cannot be claimed with a query, a header or another person's ID in the address", async () => {
    const response = await request(app)
      .get(`/api/operator/overview?userId=${OPERATOR}&isOperator=true`)
      .set("Cookie", customerCookie)
      .set("X-User-Id", String(OPERATOR))
      .set("X-Operator", "true");

    expect(response.status).toBe(404);
  });

  it("does not accept another method", async () => {
    const response = await request(app)
      .post("/api/operator/overview")
      .set("Cookie", operatorCookie)
      .set("Origin", PUBLIC_URL);

    expect(response.status).toBe(404);
  });

  it("logs who read it", async () => {
    await get("/api/operator/overview");

    expect(logger.entries).toContainEqual({
      level: "info",
      message: "Operator overview read",
      fields: { userId: OPERATOR },
    });
  });
});

describe("telling the dashboard who is an operator", () => {
  it("says so in the profile, for the operator only", async () => {
    const operator = (await get("/api/me")).body as { isOperator: boolean };
    const customer = (await get("/api/me", customerCookie)).body as { isOperator: boolean };

    expect([operator.isOperator, customer.isOperator]).toEqual([true, false]);
  });

  it("says no to everyone when no operator is configured", async () => {
    app = buildApp(null);

    expect(((await get("/api/me")).body as { isOperator: boolean }).isOperator).toBe(false);
  });
});

describe("what the operator's view holds", () => {
  it("is all zeros and empty lists on a service nobody has used", async () => {
    await test.database.query("TRUNCATE sessions");
    operatorCookie = await signInAs(OPERATOR, []);

    const body = await overview();

    expect(body).toMatchObject({
      totals: { installations: 0, repositories: 0, people: 1 },
      reviews: {
        day: { completed: 0, skipped: 0, failed: 0 },
        week: { completed: 0, skipped: 0, failed: 0 },
        month: { completed: 0, skipped: 0, failed: 0 },
      },
      aiReviews: { completed: 0, skipped: 0, failed: 0 },
      pending: { count: 0, oldestRequestedAt: null },
      keysByProvider: [],
      installations: [],
      queue: { running: 0, waiting: 0 },
    });
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
  });

  it("counts reviews by outcome in the last day, week and month, across installations", async () => {
    await seedRepository(ACME);
    await seedRepository(RIVAL);
    await seedReview(ACME.repositoryId, "completed", 1);
    await seedReview(ACME.repositoryId, "failed", 2);
    await seedReview(RIVAL.repositoryId, "completed", 3);
    await seedReview(RIVAL.repositoryId, "skipped", 48);
    await seedReview(RIVAL.repositoryId, "failed", 24 * 10);
    await seedReview(ACME.repositoryId, "completed", 24 * 40);

    const { reviews, totals } = await overview();

    expect(reviews).toEqual({
      day: { completed: 2, skipped: 0, failed: 1 },
      week: { completed: 2, skipped: 1, failed: 1 },
      month: { completed: 2, skipped: 1, failed: 2 },
    });
    expect(totals).toEqual({ installations: 2, repositories: 2, people: 2 });
  });

  it("counts AI reviews of the last 30 days by outcome", async () => {
    await seedRepository(ACME);
    await seedAiReview(await seedReview(ACME.repositoryId, "completed", 1), "completed");
    await seedAiReview(await seedReview(ACME.repositoryId, "completed", 2), "completed");
    await seedAiReview(await seedReview(ACME.repositoryId, "completed", 3), "failed");
    await seedAiReview(await seedReview(ACME.repositoryId, "completed", 4), "skipped");
    await seedAiReview(await seedReview(ACME.repositoryId, "completed", 24 * 45), "completed");

    expect((await overview()).aiReviews).toEqual({ completed: 2, skipped: 1, failed: 1 });
  });

  it("lists each installation with its account and counts, most recently active first", async () => {
    await seedRepository(ACME);
    await seedRepository(RIVAL);
    await seedRepository({ ...ACME, repositoryId: 2003, name: "REPO-CANARY-three" });
    await seedReview(ACME.repositoryId, "completed", 5);
    await seedReview(2003, "failed", 6);
    await seedReview(ACME.repositoryId, "failed", 24 * 40);
    await seedReview(RIVAL.repositoryId, "completed", 1);
    await test.database.query(
      `INSERT INTO installation_ai_keys
         (installation_id, provider, model, region, key_ciphertext, key_nonce, key_id, key_hint,
          updated_by)
       VALUES ($1, 'bedrock', 'm', 'us-east-1', 'KEY-CANARY', decode(repeat('00', 12), 'hex'),
               'k', 'HINT', 1)`,
      [ACME.installationId],
    );

    const { installations, keysByProvider } = await overview();

    expect(installations).toEqual([
      {
        installationId: RIVAL.installationId,
        account: "rival",
        repositoryCount: 1,
        reviewCount: 1,
        failedCount: 0,
        lastReviewAt: expect.stringMatching(/^\d{4}-/) as string,
        aiProvider: null,
      },
      {
        installationId: ACME.installationId,
        account: "acme",
        repositoryCount: 2,
        reviewCount: 2,
        failedCount: 1,
        lastReviewAt: expect.stringMatching(/^\d{4}-/) as string,
        aiProvider: "bedrock",
      },
    ]);
    expect(keysByProvider).toEqual([{ provider: "bedrock", count: 1 }]);
  });

  it("lists an installation that was never reviewed last, without a date", async () => {
    await seedRepository(ACME);
    await seedRepository(RIVAL);
    await seedReview(RIVAL.repositoryId, "completed", 1);

    const { installations } = await overview();

    expect(
      installations.map(({ account, lastReviewAt }) => [account, lastReviewAt === null]),
    ).toEqual([
      ["rival", false],
      ["acme", true],
    ]);
  });

  it("lists at most a hundred installations", async () => {
    await test.database.query(
      `INSERT INTO repositories (id, installation_id, owner, name)
       SELECT 100000 + n, 500000 + n, 'owner-' || n, 'repo' FROM generate_series(1, $1) AS n`,
      [MAX_INSTALLATIONS + 5],
    );

    const body = await overview();

    expect(body.installations).toHaveLength(MAX_INSTALLATIONS);
    expect(body.totals.installations).toBe(MAX_INSTALLATIONS + 5);
  });

  it("says how many reviews were requested and have not finished, and since when", async () => {
    await test.database.query(
      `INSERT INTO pending_reviews
         (repository_id, pull_request_number, installation_id, owner, name, action, requested_at)
       VALUES (2002, 1, 1001, 'acme', 'REPO-CANARY-one', 'opened', now() - interval '2 hours'),
              (2002, 2, 1001, 'acme', 'REPO-CANARY-one', 'opened', now())`,
    );

    const { pending } = await overview();

    expect(pending.count).toBe(2);
    const ageMs = Date.now() - Date.parse(pending.oldestRequestedAt ?? "");
    expect(ageMs).toBeGreaterThan(110 * 60_000);
    expect(ageMs).toBeLessThan(130 * 60_000);
  });

  it("says what this process is running and holding back right now", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    reviewQueue.enqueue("a", "1001", () => held);
    reviewQueue.enqueue("b", "1001", () => Promise.resolve());
    reviewQueue.enqueue("c", "9009", () => Promise.resolve());

    expect((await overview()).queue).toEqual({ running: 1, waiting: 2 });

    release();
    await reviewQueue.onIdle();
    expect((await overview()).queue).toEqual({ running: 0, waiting: 0 });
  });

  it("counts people with a session that has not ended, once each", async () => {
    await signInAs(CUSTOMER, [RIVAL.installationId]);
    await test.database.query(
      `INSERT INTO sessions (token_hash, user_id, login, installation_ids, created_at, expires_at)
       VALUES (repeat('e', 64), 555, 'gone', '{}', now() - interval '9 hours', now() - interval '1 hour')`,
    );

    expect((await overview()).totals.people).toBe(2);
  });

  it("holds no repository name, pull request, error, model, login, key or key hint", async () => {
    await seedRepository(ACME);
    await seedRepository(RIVAL);
    await seedAiReview(await seedReview(ACME.repositoryId, "failed", 1), "failed");
    await seedReview(RIVAL.repositoryId, "completed", 1);
    await test.database.query(
      `INSERT INTO installation_ai_keys
         (installation_id, provider, model, key_ciphertext, key_nonce, key_id, key_hint, updated_by)
       VALUES ($1, 'anthropic', 'MODEL-CANARY', 'KEY-CANARY', decode(repeat('00', 12), 'hex'),
               'k', 'HINT', 1)`,
      [ACME.installationId],
    );

    const text = JSON.stringify(await overview());

    for (const canary of ["CANARY", "4242", "HINT", "LOGIN", "src/"]) {
      expect(text).not.toContain(canary);
    }
    expect(logger.text()).not.toContain("CANARY");
  });
});

describe("keeping the cross-installation store away from everyone else", () => {
  it("leaves a customer's own overview limited to their installations", async () => {
    await seedRepository(ACME);
    await seedRepository(RIVAL);
    await seedReview(ACME.repositoryId, "completed", 1);
    await seedReview(RIVAL.repositoryId, "completed", 1);
    await seedReview(RIVAL.repositoryId, "completed", 2);

    const customer = (await get("/api/overview", customerCookie)).body as { reviewCount: number };
    const operatorAsCustomer = (await get("/api/overview")).body as { reviewCount: number };

    // The operator's own history page is as limited as anyone's: only the special view is not.
    expect([customer.reviewCount, operatorAsCustomer.reviewCount]).toEqual([2, 1]);
  });
});
