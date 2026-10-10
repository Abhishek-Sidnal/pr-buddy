import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignInError, type UserAccess, type UserAuthClient } from "@pr-buddy/github-client";
import { createReviewEngine } from "@pr-buddy/review-engine";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { migrate } from "../../src/database/migrate.js";
import { createPostgresSessionStore } from "../../src/modules/auth/postgres-session-store.js";
import type { SessionStore } from "../../src/modules/auth/session-store.js";
import { createInMemoryDeliveryStore } from "../../src/modules/github/delivery-store.js";
import { createPostgresHistoryStore } from "../../src/modules/history/postgres-history-store.js";
import { createPostgresReviewStore } from "../../src/modules/reviews/postgres-review-store.js";
import { createReviewQueue } from "../../src/modules/reviews/review-queue.js";
import type { ReviewRecord } from "../../src/modules/reviews/review-store.js";
import { createReviewService } from "../../src/modules/reviews/review.service.js";
import { BASE_SHA, FakeGitHub, HEAD_SHA } from "../helpers/fake-github.js";
import { createRecordingLogger, type RecordingLogger } from "../helpers/recording-logger.js";
import { createTestDatabase, type TestDatabase } from "../helpers/test-database.js";

const PUBLIC_URL = "http://localhost:3000";
const SESSION_COOKIE = "prbuddy_session";
const STATE_COOKIE = "prbuddy_state";

/** Two tenants: everything is seen through OURS, and THEIRS must never show. */
const OURS = { installationId: 1001, repositoryId: 2002 };
const THEIRS = { installationId: 9009, repositoryId: 3003 };

let test: TestDatabase;
let webRoot: string;
let logger: RecordingLogger;
let sessionStore: SessionStore;
let app: Express;

/** Stands in for GitHub's sign-in: answers with `access`, or throws `failure`. */
const github = {
  access: {
    user: { id: 583231, login: "octocat" },
    installationIds: [OURS.installationId],
  } as UserAccess,
  failure: undefined as Error | undefined,
  signIns: [] as { code: string; redirectUri: string }[],
};
const authClient: UserAuthClient = {
  authorizeUrl: (state, redirectUri) =>
    `https://github.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  signIn(code, redirectUri) {
    github.signIns.push({ code, redirectUri });
    return github.failure === undefined
      ? Promise.resolve(github.access)
      : Promise.reject(github.failure);
  },
};

interface AppOverrides {
  publicUrl?: string;
  authRateLimit?: number;
  withDashboard?: boolean;
}

function buildApp(overrides: AppOverrides = {}): Express {
  const fakeGitHub = new FakeGitHub();
  return createApp({
    webhookSecret: "0123456789abcdef-webhook-secret",
    deliveryStore: createInMemoryDeliveryStore(),
    reviewQueue: createReviewQueue({ concurrency: 1, maxWaiting: 1, onError: () => undefined }),
    reviewService: createReviewService({ clientFactory: fakeGitHub.clientFactory, logger }),
    logger,
    trustProxy: 0,
    webhookRateLimit: 1_000,
    ...(overrides.withDashboard === false
      ? {}
      : {
          dashboard: {
            authClient,
            sessionStore,
            historyStore: createPostgresHistoryStore(test.database),
            publicUrl: overrides.publicUrl ?? PUBLIC_URL,
            webRoot,
            authRateLimit: overrides.authRateLimit ?? 1_000,
            apiRateLimit: 1_000,
          },
        }),
  });
}

/** The value of a cookie the response sets, or `undefined` if it does not set it. */
function setCookieValue(response: request.Response, name: string): string | undefined {
  const header = response.headers["set-cookie"] as string[] | string | undefined;
  const cookies = header === undefined ? [] : [header].flat();
  const cookie = cookies.find((entry) => entry.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1).split(";")[0];
}

function setCookieLine(response: request.Response, name: string): string {
  const header = response.headers["set-cookie"] as string[] | string | undefined;
  return [header ?? []].flat().find((entry) => entry.startsWith(`${name}=`)) ?? "";
}

/** Walks through sign-in and returns the session cookie, ready for a `Cookie` header. */
async function signIn(target: Express = app): Promise<string> {
  const login = await request(target).get("/auth/login");
  const state = setCookieValue(login, STATE_COOKIE) ?? "";
  const callback = await request(target)
    .get("/auth/callback")
    .query({ code: "good-code", state })
    .set("Cookie", `${STATE_COOKIE}=${state}`);
  return `${SESSION_COOKIE}=${setCookieValue(callback, SESSION_COOKIE) ?? ""}`;
}

let reviewCounter = 0;

/** Stores one review of a pull request with a missing description and no tests. */
async function seedReview(
  tenant: { installationId: number; repositoryId: number },
  overrides: Partial<ReviewRecord> = {},
): Promise<void> {
  reviewCounter += 1;
  const startedAt = new Date(Date.UTC(2026, 9, 10, 10, 0, reviewCounter));
  const result = await createReviewEngine().review({
    pullRequest: { number: 7, title: "T", body: null, baseSha: BASE_SHA, headSha: HEAD_SHA },
    files: [{ path: "src/feature.ts", status: "added", additions: 1, deletions: 0 }],
  });
  await createPostgresReviewStore(test.database).save({
    installationId: tenant.installationId,
    repository: {
      id: tenant.repositoryId,
      owner: tenant === OURS ? "acme" : "rival",
      name: tenant === OURS ? "widgets" : "secrets",
    },
    pullRequestNumber: 7,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    startedAt,
    completedAt: new Date(startedAt.getTime() + 1_500),
    outcome: {
      status: "completed",
      comment: "created",
      skippedFileCount: 0,
      omittedPatchCount: 0,
      result,
    },
    ...overrides,
  });
}

async function reviewIdsOf(repositoryId: number): Promise<string[]> {
  const result = await test.database.query<{ id: string }>(
    "SELECT id FROM reviews WHERE repository_id = $1 ORDER BY started_at DESC, id DESC",
    [repositoryId],
  );
  return result.rows.map((row) => row.id);
}

beforeAll(async () => {
  test = await createTestDatabase();
  await migrate(test.database);
  webRoot = mkdtempSync(join(tmpdir(), "prbuddy-web-"));
  mkdirSync(join(webRoot, "assets"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>PR Buddy</title>");
  writeFileSync(join(webRoot, "assets", "app-abc123.js"), "console.log('app');");
});

afterAll(async () => {
  rmSync(webRoot, { recursive: true, force: true });
  await test.destroy();
});

beforeEach(async () => {
  await test.database.query("TRUNCATE repositories, sessions CASCADE");
  github.access = {
    user: { id: 583231, login: "octocat" },
    installationIds: [OURS.installationId],
  };
  github.failure = undefined;
  github.signIns = [];
  logger = createRecordingLogger();
  sessionStore = createPostgresSessionStore(test.database);
  app = buildApp();
});

describe("without the dashboard", () => {
  it.each(["/auth/login", "/auth/callback", "/api/me", "/", "/repositories"])(
    "has no route at %s",
    async (path) => {
      const response = await request(buildApp({ withDashboard: false })).get(path);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "not_found" });
    },
  );
});

describe("signing in", () => {
  it("sends the browser to GitHub with a fresh state, kept in a cookie", async () => {
    const first = await request(app).get("/auth/login");
    const second = await request(app).get("/auth/login");

    const state = setCookieValue(first, STATE_COOKIE) ?? "";
    expect(first.status).toBe(302);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.headers["location"]).toBe(
      `https://github.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(`${PUBLIC_URL}/auth/callback`)}`,
    );
    expect(setCookieLine(first, STATE_COOKIE)).toBe(
      `${STATE_COOKIE}=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax`,
    );
    expect(setCookieValue(second, STATE_COOKIE)).not.toBe(state);
  });

  it("uses Secure cookies with the __Host- prefix over HTTPS", async () => {
    const secure = buildApp({ publicUrl: "https://buddy.example" });

    const login = await request(secure).get("/auth/login");

    expect(setCookieLine(login, "__Host-prbuddy_state")).toMatch(
      /^__Host-prbuddy_state=[\w-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/,
    );
    expect(login.headers["location"]).toContain(
      encodeURIComponent("https://buddy.example/auth/callback"),
    );
  });

  it("creates a session when GitHub sends the person back", async () => {
    const login = await request(app).get("/auth/login");
    const state = setCookieValue(login, STATE_COOKIE) ?? "";

    const callback = await request(app)
      .get("/auth/callback")
      .query({ code: "good-code", state })
      .set("Cookie", `${STATE_COOKIE}=${state}`);

    const token = setCookieValue(callback, SESSION_COOKIE) ?? "";
    expect(callback.status).toBe(302);
    expect(callback.headers["location"]).toBe("/");
    expect(github.signIns).toEqual([
      { code: "good-code", redirectUri: `${PUBLIC_URL}/auth/callback` },
    ]);
    expect(setCookieLine(callback, SESSION_COOKIE)).toBe(
      `${SESSION_COOKIE}=${token}; Path=/; Max-Age=28800; HttpOnly; SameSite=Lax`,
    );
    expect(setCookieLine(callback, STATE_COOKIE)).toContain("Max-Age=0");
    expect(await sessionStore.find(token)).toMatchObject({
      userId: 583231,
      login: "octocat",
      installationIds: [OURS.installationId],
    });
  });

  it("stores a hash of the session token, never the token", async () => {
    const cookie = await signIn();
    const token = cookie.split("=")[1] ?? "";

    const rows = await test.database.query("SELECT * FROM sessions");

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.["token_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows.rows)).not.toContain(token);
    expect(logger.text()).not.toContain(token);
  });

  it("logs the sign-in by user ID, without the login or the code", async () => {
    await signIn();

    expect(logger.entries).toContainEqual({
      level: "info",
      message: "Signed in",
      fields: { userId: 583231, installationCount: 1 },
    });
    expect(logger.text()).not.toContain("good-code");
    expect(logger.text()).not.toContain("octocat");
  });

  it.each([
    ["no state cookie", { state: "a".repeat(43), cookie: undefined }],
    ["a state that differs from the cookie", { state: "a".repeat(43), cookie: "b".repeat(43) }],
    ["a state of another length", { state: "a".repeat(10), cookie: "a".repeat(10) }],
    ["no state in the request", { state: undefined, cookie: "a".repeat(43) }],
  ])("refuses a callback with %s, without asking GitHub", async (_name, { state, cookie }) => {
    const pending = request(app)
      .get("/auth/callback")
      .query({ code: "good-code", ...(state === undefined ? {} : { state }) });
    const response = await (cookie === undefined
      ? pending
      : pending.set("Cookie", `${STATE_COOKIE}=${cookie}`));

    expect(response.status).toBe(302);
    expect(response.headers["location"]).toBe("/?sign-in=failed");
    expect(setCookieValue(response, SESSION_COOKIE)).toBeUndefined();
    expect(github.signIns).toEqual([]);
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "Sign-in failed",
      fields: { reason: "state-mismatch" },
    });
  });

  it.each([
    ["no code, as when the person declines", { error: "access_denied" }],
    ["a code that could not be GitHub's", { code: "bad code <script>" }],
    ["a code given twice", { code: ["one", "two"] }],
  ])("refuses a callback with %s", async (_name, query) => {
    const state = "s".repeat(43);

    const response = await request(app)
      .get("/auth/callback")
      .query({ ...query, state })
      .set("Cookie", `${STATE_COOKIE}=${state}`);

    expect(response.headers["location"]).toBe("/?sign-in=failed");
    expect(github.signIns).toEqual([]);
    expect(setCookieLine(response, STATE_COOKIE)).toContain("Max-Age=0");
  });

  it("creates no session when GitHub rejects the code", async () => {
    github.failure = new SignInError("code-rejected");
    const state = "s".repeat(43);

    const response = await request(app)
      .get("/auth/callback")
      .query({ code: "used-code", state })
      .set("Cookie", `${STATE_COOKIE}=${state}`);

    expect(response.headers["location"]).toBe("/?sign-in=failed");
    expect(setCookieValue(response, SESSION_COOKIE)).toBeUndefined();
    expect((await test.database.query("SELECT 1 FROM sessions")).rowCount).toBe(0);
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "Sign-in failed",
      fields: { reason: "code-rejected" },
    });
  });

  it("answers 500 without details when sign-in breaks unexpectedly", async () => {
    github.failure = new Error("boom");
    const state = "s".repeat(43);

    const response = await request(app)
      .get("/auth/callback")
      .query({ code: "good-code", state })
      .set("Cookie", `${STATE_COOKIE}=${state}`);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error" });
  });

  it("limits how often one address may try", async () => {
    const limited = buildApp({ authRateLimit: 2 });

    await request(limited).get("/auth/login");
    await request(limited).get("/auth/login");
    const third = await request(limited).get("/auth/login");

    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: "rate_limited" });
  });
});

describe("sessions", () => {
  it("answers 401 without a session", async () => {
    const response = await request(app).get("/api/me");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "unauthenticated" });
  });

  it.each([
    ["a made-up token", `${SESSION_COOKIE}=${"x".repeat(43)}`],
    ["a token of the wrong shape", `${SESSION_COOKIE}=' OR 1=1 --`],
    ["an empty token", `${SESSION_COOKIE}=`],
    ["another cookie only", "theme=dark"],
    ["an enormous header", `${SESSION_COOKIE}=${"x".repeat(9_000)}`],
  ])("answers 401 for %s", async (_name, cookie) => {
    expect((await request(app).get("/api/me").set("Cookie", cookie)).status).toBe(401);
  });

  it("finds the session among other cookies", async () => {
    const cookie = await signIn();

    const response = await request(app).get("/api/me").set("Cookie", `theme=dark; ${cookie}; x=1`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ login: "octocat", installationCount: 1 });
  });

  it("stops working once it has expired", async () => {
    const cookie = await signIn();
    await test.database.query(
      "UPDATE sessions SET created_at = now() - interval '9 hours', expires_at = now() - interval '1 hour'",
    );

    expect((await request(app).get("/api/me").set("Cookie", cookie)).status).toBe(401);
  });

  it("lasts eight hours from sign-in", async () => {
    await signIn();

    const rows = await test.database.query<{ seconds: string }>(
      "SELECT extract(epoch FROM expires_at - created_at)::int AS seconds FROM sessions",
    );

    expect(Number(rows.rows[0]?.seconds)).toBe(28_800);
  });

  it("deletes expired sessions from time to time", async () => {
    const store = createPostgresSessionStore(test.database, { purgeEvery: 2 });
    const session = { userId: 1, login: "a", installationIds: [] };
    await store.create(session);
    await test.database.query(
      "UPDATE sessions SET created_at = now() - interval '9 hours', expires_at = now() - interval '1 hour'",
    );

    await store.create(session);

    expect((await test.database.query("SELECT 1 FROM sessions")).rowCount).toBe(1);
  });

  it("ends on sign-out", async () => {
    const cookie = await signIn();

    const logout = await request(app).post("/auth/logout").set("Cookie", cookie);

    expect(logout.status).toBe(204);
    expect(setCookieLine(logout, SESSION_COOKIE)).toContain("Max-Age=0");
    expect((await request(app).get("/api/me").set("Cookie", cookie)).status).toBe(401);
    expect((await test.database.query("SELECT 1 FROM sessions")).rowCount).toBe(0);
  });

  it("accepts sign-out from the dashboard's own origin and without a session", async () => {
    const own = await request(app).post("/auth/logout").set("Origin", PUBLIC_URL);
    const none = await request(app).post("/auth/logout");

    expect([own.status, none.status]).toEqual([204, 204]);
  });

  it("refuses sign-out sent from another site", async () => {
    const cookie = await signIn();

    const response = await request(app)
      .post("/auth/logout")
      .set("Cookie", cookie)
      .set("Origin", "https://evil.example");

    expect(response.status).toBe(403);
    expect((await request(app).get("/api/me").set("Cookie", cookie)).status).toBe(200);
  });

  it("does not sign out on a GET", async () => {
    const cookie = await signIn();

    await request(app).get("/auth/logout").set("Cookie", cookie);

    expect((await request(app).get("/api/me").set("Cookie", cookie)).status).toBe(200);
  });
});

describe("the read API", () => {
  let cookie: string;

  beforeEach(async () => {
    await seedReview(OURS);
    await seedReview(OURS);
    await seedReview(THEIRS);
    cookie = await signIn();
  });

  const get = (path: string): request.Test => request(app).get(path).set("Cookie", cookie);

  it.each(["/api/overview", "/api/repositories", "/api/repositories/2002/reviews"])(
    "needs a session for %s",
    async (path) => {
      expect((await request(app).get(path)).status).toBe(401);
    },
  );

  it("says who is signed in, and nothing GitHub-private", async () => {
    const response = await get("/api/me");

    expect(Object.keys(response.body as object).sort()).toEqual([
      "expiresAt",
      "installationCount",
      "login",
    ]);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("totals only what the session may see", async () => {
    const { body } = (await get("/api/overview")) as { body: Record<string, unknown> };

    expect(body).toMatchObject({
      repositoryCount: 1,
      reviewCount: 2,
      completedCount: 2,
      skippedCount: 0,
      failedCount: 0,
      findingCount: 4,
    });
    expect(body["recentReviews"]).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("rival");
  });

  it("counts skipped and failed reviews, and ignores reviews older than 30 days", async () => {
    await seedReview(OURS, { outcome: { status: "skipped", reason: "draft" } });
    await seedReview(OURS, { outcome: { status: "failed", errorName: "HttpError" } });
    await seedReview(OURS, {
      startedAt: new Date("2020-01-01T00:00:00Z"),
      completedAt: new Date("2020-01-01T00:00:01Z"),
    });

    const body: unknown = (await get("/api/overview")).body;

    expect(body).toMatchObject({
      reviewCount: 4,
      completedCount: 2,
      skippedCount: 1,
      failedCount: 1,
    });
  });

  it("lists visible repositories with their latest review", async () => {
    const body: unknown = (await get("/api/repositories")).body;

    expect(body).toEqual({
      repositories: [
        {
          id: OURS.repositoryId,
          owner: "acme",
          name: "widgets",
          reviewCount: 2,
          lastReviewedAt: expect.stringMatching(/^2026-10-10T10:00:\d\d\.000Z$/) as string,
          lastStatus: "completed",
        },
      ],
    });
  });

  it("lists a repository's reviews, newest first", async () => {
    const { body } = (await get(`/api/repositories/${OURS.repositoryId}/reviews`)) as {
      body: { repository: unknown; reviews: { id: string }[]; nextCursor: unknown };
    };

    expect(body.repository).toEqual({ id: OURS.repositoryId, owner: "acme", name: "widgets" });
    expect(body.reviews.map(({ id }) => id)).toEqual(await reviewIdsOf(OURS.repositoryId));
    expect(body.nextCursor).toBeNull();
    expect(body.reviews[0]).toMatchObject({
      repository: { id: OURS.repositoryId, owner: "acme", name: "widgets" },
      pullRequestNumber: 7,
      headSha: HEAD_SHA,
      status: "completed",
      skipReason: null,
      findingCount: 2,
      suppressedFindingCount: 0,
      aiFindingCount: null,
      durationMs: 1_500,
    });
  });

  it("pages through reviews without repeating or skipping any", async () => {
    for (let index = 0; index < 28; index += 1) {
      await seedReview(OURS);
    }
    const path = `/api/repositories/${OURS.repositoryId}/reviews`;
    interface Page {
      reviews: { id: string }[];
      nextCursor: string | null;
    }

    const first = (await get(path)).body as Page;
    const second = (await get(path).query({ cursor: first.nextCursor ?? "" })).body as Page;

    expect(first.reviews).toHaveLength(25);
    expect(first.nextCursor).toMatch(/^2026-10-10T10:00:\d\d\.000Z~[0-9a-f-]{36}$/);
    expect(second.reviews).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect([...first.reviews, ...second.reviews].map(({ id }) => id)).toEqual(
      await reviewIdsOf(OURS.repositoryId),
    );
  });

  it.each([
    "nonsense",
    "2026-10-10T10:00:00.000Z",
    "2026-10-10T10:00:00.000Z~not-a-uuid",
    "not-a-date~00000000-0000-4000-8000-000000000000",
    "2026-10-10T10:00:00.000Z~00000000-0000-4000-8000-000000000000~extra",
    "'; DROP TABLE reviews; --",
    "x".repeat(500),
  ])("rejects the cursor %s", async (cursor) => {
    const response = await get(`/api/repositories/${OURS.repositoryId}/reviews`).query({ cursor });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid_cursor" });
  });

  it("shows one review with its findings and the rules that ran", async () => {
    const [reviewId] = await reviewIdsOf(OURS.repositoryId);

    const { body } = (await get(`/api/reviews/${reviewId ?? ""}`)) as {
      body: { findings: { ruleId: string }[]; rules: { ruleId: string }[] } & Record<
        string,
        unknown
      >;
    };

    expect(body).toMatchObject({
      id: reviewId,
      baseSha: BASE_SHA,
      commentAction: "created",
      skippedFileCount: 0,
      omittedPatchCount: 0,
      errorName: null,
      errorStatus: null,
      aiReview: null,
    });
    expect(body.findings.map(({ ruleId }) => ruleId).sort()).toEqual([
      "missing-test-changes",
      "pr-description",
    ]);
    expect(body.findings[0]).toHaveProperty("evidence");
    expect(body.rules).toHaveLength(7);
  });

  it("shows the AI review record without the provider's error name", async () => {
    const result = await createReviewEngine().review({
      pullRequest: { number: 7, title: "T", body: null, baseSha: BASE_SHA, headSha: HEAD_SHA },
      files: [],
    });
    await seedReview(OURS, {
      outcome: {
        status: "completed",
        comment: "created",
        skippedFileCount: 0,
        omittedPatchCount: 0,
        result,
        aiReview: {
          provider: "example",
          model: "model-1",
          status: "failed",
          failureReason: "provider-error",
          errorName: "InternalProviderError",
          findingCount: 0,
          suppressedFindingCount: 0,
          rejectedFindingCount: 0,
          sentFileCount: 1,
          omittedFileCount: 0,
          durationMs: 40,
        },
      },
    });
    const [reviewId] = await reviewIdsOf(OURS.repositoryId);

    const response = await get(`/api/reviews/${reviewId ?? ""}`);

    expect((response.body as { aiReview: unknown }).aiReview).toEqual({
      provider: "example",
      model: "model-1",
      status: "failed",
      failureReason: "provider-error",
      findingCount: 0,
      suppressedFindingCount: 0,
      rejectedFindingCount: 0,
      sentFileCount: 1,
      omittedFileCount: 0,
      inputTokens: null,
      outputTokens: null,
      durationMs: 40,
    });
    expect(JSON.stringify(response.body)).not.toContain("InternalProviderError");
    expect((response.body as { aiFindingCount: unknown }).aiFindingCount).toBe(0);
  });

  describe("another tenant's data", () => {
    it("is not listed", async () => {
      const responses = await Promise.all([get("/api/overview"), get("/api/repositories")]);

      for (const response of responses) {
        expect(JSON.stringify(response.body)).not.toContain("rival");
        expect(JSON.stringify(response.body)).not.toContain(String(THEIRS.repositoryId));
      }
    });

    it("answers 404 for their repository, exactly as for one that does not exist", async () => {
      const theirs = await get(`/api/repositories/${THEIRS.repositoryId}/reviews`);
      const missing = await get("/api/repositories/424242/reviews");

      expect(theirs.status).toBe(404);
      expect(theirs.body).toEqual(missing.body);
      expect(theirs.body).toEqual({ error: "not_found" });
    });

    it("answers 404 for their review, exactly as for one that does not exist", async () => {
      const [theirReviewId] = await reviewIdsOf(THEIRS.repositoryId);

      const theirs = await get(`/api/reviews/${theirReviewId ?? ""}`);
      const missing = await get("/api/reviews/00000000-0000-4000-8000-000000000000");

      expect(theirReviewId).toBeDefined();
      expect(theirs.status).toBe(404);
      expect(theirs.body).toEqual(missing.body);
    });

    it("cannot be reached with a cursor taken from their reviews", async () => {
      const [theirReviewId] = await reviewIdsOf(THEIRS.repositoryId);

      const response = await get(`/api/repositories/${THEIRS.repositoryId}/reviews`).query({
        cursor: `2030-01-01T00:00:00.000Z~${theirReviewId ?? ""}`,
      });

      expect(response.status).toBe(404);
    });

    it("becomes visible only to a session that GitHub lists it for", async () => {
      github.access = {
        user: { id: 2, login: "rival-dev" },
        installationIds: [THEIRS.installationId],
      };
      const theirCookie = await signIn();

      const response = await request(app).get("/api/repositories").set("Cookie", theirCookie);

      expect(
        (response.body as { repositories: { owner: string }[] }).repositories.map(
          ({ owner }) => owner,
        ),
      ).toEqual(["rival"]);
    });

    it("follows a repository that moves to another installation", async () => {
      await seedReview({ installationId: THEIRS.installationId, repositoryId: OURS.repositoryId });

      expect((await get("/api/repositories")).body).toEqual({ repositories: [] });
      expect((await get(`/api/repositories/${OURS.repositoryId}/reviews`)).status).toBe(404);
    });
  });

  it("shows nothing to a person with no installations", async () => {
    github.access = { user: { id: 3, login: "newcomer" }, installationIds: [] };
    const emptyCookie = await signIn();
    const asNewcomer = (path: string): request.Test =>
      request(app).get(path).set("Cookie", emptyCookie);

    expect((await asNewcomer("/api/repositories")).body).toEqual({ repositories: [] });
    expect((await asNewcomer("/api/overview")).body).toMatchObject({
      repositoryCount: 0,
      reviewCount: 0,
      findingCount: 0,
      recentReviews: [],
    });
    expect((await asNewcomer(`/api/repositories/${OURS.repositoryId}/reviews`)).status).toBe(404);
  });

  it.each([
    "/api/repositories/abc/reviews",
    "/api/repositories/0/reviews",
    "/api/repositories/-1/reviews",
    "/api/repositories/1%20OR%201=1/reviews",
    "/api/repositories/99999999999999999999/reviews",
    "/api/reviews/not-a-uuid",
    "/api/reviews/1%27%20OR%20%271%27=%271",
    "/api/unknown",
    "/api",
  ])("answers 404 in JSON for %s", async (path) => {
    const response = await get(path);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not_found" });
  });
});

describe("the web application", () => {
  it.each(["/", "/repositories", "/repositories/2002", "/reviews/abc", "/anything/else"])(
    "serves the page at %s, uncached and under a strict policy",
    async (path) => {
      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(response.text).toContain("<title>PR Buddy</title>");
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    },
  );

  it("serves hashed assets with long caching", async () => {
    const response = await request(app).get("/assets/app-abc123.js");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it.each(["/assets/missing.js", "/assets/../index.html", "/assets/%2e%2e/%2e%2e/etc/passwd"])(
    "does not serve the page, or any other file, for %s",
    async (path) => {
      const response = await request(app).get(path);

      expect(response.text).not.toContain("root:");
      expect([200, 404]).toContain(response.status);
      if (response.status === 404) {
        expect(response.body).toEqual({ error: "not_found" });
      }
    },
  );

  it("answers other methods with 404", async () => {
    expect((await request(app).post("/")).status).toBe(404);
    expect((await request(app).delete("/repositories")).status).toBe(404);
  });

  it("answers 500 in JSON when the web application has not been built", async () => {
    const unbuilt = createApp({
      webhookSecret: "0123456789abcdef-webhook-secret",
      deliveryStore: createInMemoryDeliveryStore(),
      reviewQueue: createReviewQueue({ concurrency: 1, maxWaiting: 1, onError: () => undefined }),
      reviewService: createReviewService({
        clientFactory: new FakeGitHub().clientFactory,
        logger,
      }),
      logger,
      trustProxy: 0,
      webhookRateLimit: 1_000,
      dashboard: {
        authClient,
        sessionStore,
        historyStore: createPostgresHistoryStore(test.database),
        publicUrl: PUBLIC_URL,
        webRoot: join(webRoot, "does-not-exist"),
        authRateLimit: 1_000,
        apiRateLimit: 1_000,
      },
    });

    const response = await request(unbuilt).get("/");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error" });
  });

  it("keeps the service's own routes", async () => {
    expect((await request(app).get("/healthz")).body).toEqual({ status: "ok" });
  });
});
