import { signWebhookBody, SUMMARY_MARKER } from "@pr-buddy/github-client";
import type { Express } from "express";
import request, { type Response } from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import {
  createInMemoryDeliveryStore,
  type DeliveryStore,
} from "../../src/modules/github/delivery-store.js";
import {
  createReviewErrorLogger,
  MAX_WEBHOOK_BODY_BYTES,
} from "../../src/modules/github/webhook.router.js";
import { createReviewQueue, type ReviewQueue } from "../../src/modules/reviews/review-queue.js";
import { createReviewService } from "../../src/modules/reviews/review.service.js";
import { FakeGitHub, httpError, NEWER_HEAD_SHA } from "../helpers/fake-github.js";
import { createRecordingLogger, type RecordingLogger } from "../helpers/recording-logger.js";

const WEBHOOK_SECRET = "0123456789abcdef-webhook-secret";

let github: FakeGitHub;
let logger: RecordingLogger;
let reviewQueue: ReviewQueue;
let app: Express;
let deliveryCounter = 0;

interface AppOverrides {
  deliveryStore?: DeliveryStore;
  webhookRateLimit?: number;
  isReady?: () => Promise<boolean>;
  concurrency?: number;
  maxWaiting?: number;
  maxWaitingPerGroup?: number;
}

function buildApp(overrides: AppOverrides = {}): Express {
  reviewQueue = createReviewQueue({
    concurrency: overrides.concurrency ?? 2,
    maxWaiting: overrides.maxWaiting ?? 10,
    ...(overrides.maxWaitingPerGroup === undefined
      ? {}
      : { maxWaitingPerGroup: overrides.maxWaitingPerGroup }),
    onError: createReviewErrorLogger(logger),
  });
  return createApp({
    webhookSecret: WEBHOOK_SECRET,
    deliveryStore: overrides.deliveryStore ?? createInMemoryDeliveryStore(),
    reviewQueue,
    reviewService: createReviewService({ clientFactory: github.clientFactory, logger }),
    logger,
    trustProxy: 0,
    webhookRateLimit: overrides.webhookRateLimit ?? 1_000,
    ...(overrides.isReady === undefined ? {} : { isReady: overrides.isReady }),
  });
}

beforeEach(() => {
  github = new FakeGitHub();
  // By default the fake pull request trips two rules, so a review visibly produces a comment.
  github.pullRequest = { ...github.pullRequest, body: null, changedFileCount: 1 };
  github.files = [{ path: "src/feature.ts", status: "added", additions: 10, deletions: 0 }];
  logger = createRecordingLogger();
  app = buildApp();
});

function pullRequestEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "opened",
    number: 7,
    installation: { id: 1001 },
    repository: { id: 2002, name: "widgets", owner: { login: "acme" } },
    pull_request: { title: "WEBHOOK-TITLE-CANARY", body: "WEBHOOK-BODY-CANARY" },
    ...overrides,
  });
}

interface DeliveryOptions {
  event?: string;
  deliveryId?: string | null;
  signature?: string | null;
  target?: Express;
}

/** Sends a webhook the way GitHub does. Signs the body unless a signature is given. */
function deliver(body: string, options: DeliveryOptions = {}): Promise<Response> {
  deliveryCounter += 1;
  const deliveryId =
    options.deliveryId === undefined
      ? `00000000-0000-4000-8000-${String(deliveryCounter).padStart(12, "0")}`
      : options.deliveryId;
  const signature =
    options.signature === undefined ? signWebhookBody(WEBHOOK_SECRET, body) : options.signature;

  let call = request(options.target ?? app)
    .post("/webhooks/github")
    .set("content-type", "application/json")
    .set("x-github-event", options.event ?? "pull_request");
  if (deliveryId !== null) {
    call = call.set("x-github-delivery", deliveryId);
  }
  if (signature !== null) {
    call = call.set("x-hub-signature-256", signature);
  }
  return call.send(body);
}

describe("service endpoints", () => {
  it("reports health", async () => {
    const response = await request(app).get("/healthz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("reports ready when it has no dependencies to check", async () => {
    const response = await request(app).get("/readyz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ready" });
  });

  it("reports ready or unavailable as its dependencies say", async () => {
    const ready = await request(buildApp({ isReady: () => Promise.resolve(true) })).get("/readyz");
    const down = await request(buildApp({ isReady: () => Promise.resolve(false) })).get("/readyz");

    expect(ready.status).toBe(200);
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ status: "unavailable" });
  });

  it("stays alive while it is not ready", async () => {
    const notReady = buildApp({ isReady: () => Promise.resolve(false) });

    expect((await request(notReady).get("/healthz")).status).toBe(200);
  });

  it("answers unknown routes with a JSON 404", async () => {
    const response = await request(app).get("/admin");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not_found" });
  });

  it("does not accept GET on the webhook path", async () => {
    expect((await request(app).get("/webhooks/github")).status).toBe(404);
  });

  it("sends defensive headers and does not advertise the framework", async () => {
    const response = await request(app).get("/healthz");

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers).not.toHaveProperty("x-powered-by");
  });
});

describe("webhook authentication", () => {
  it.each([
    ["a missing signature", null],
    [
      "a signature made with another secret",
      signWebhookBody("a-different-webhook-secret", pullRequestEvent()),
    ],
    ["a malformed signature", "sha256=not-hex"],
    ["a legacy SHA-1 signature", `sha1=${"a".repeat(40)}`],
  ])("rejects %s with 401 and does nothing", async (_name, signature) => {
    const response = await deliver(pullRequestEvent(), { signature });
    await reviewQueue.onIdle();

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "invalid_signature" });
    expect(github.calls).toEqual([]);
  });

  it("rejects a body that was altered after signing", async () => {
    const signature = signWebhookBody(WEBHOOK_SECRET, pullRequestEvent());

    const response = await deliver(pullRequestEvent({ number: 8 }), { signature });

    expect(response.status).toBe(401);
  });

  it("rejects an empty body", async () => {
    const response = await request(app)
      .post("/webhooks/github")
      .set("x-github-event", "pull_request");

    expect(response.status).toBe(401);
  });

  it("checks the signature before reading the delivery ID or the body", async () => {
    const response = await deliver("this is not JSON", {
      signature: "sha256=bad",
      deliveryId: null,
    });

    expect(response.status).toBe(401);
  });

  it("logs a rejected signature without logging the body", async () => {
    await deliver(pullRequestEvent(), { signature: null });

    expect(logger.entries).toEqual([
      expect.objectContaining({ level: "warn", message: "Webhook rejected: invalid signature" }),
    ]);
    expect(logger.text()).not.toMatch(/CANARY/);
  });
});

describe("webhook validation", () => {
  it.each([
    ["missing", null],
    ["too short", "abc"],
    ["made of unexpected characters", "../../etc/passwd"],
    ["too long", "a".repeat(65)],
  ])("rejects a delivery ID that is %s", async (_name, deliveryId) => {
    const response = await deliver(pullRequestEvent(), { deliveryId });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid_delivery_id" });
  });

  it("rejects a signed body that is not JSON", async () => {
    const response = await deliver("action=opened&number=7");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid_json" });
  });

  it("answers GitHub's ping", async () => {
    const response = await deliver(JSON.stringify({ zen: "Keep it logically awesome." }), {
      event: "ping",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "pong" });
  });

  it.each(["push", "issues", "check_run", "pull_request_review"])(
    "acknowledges and ignores the %s event",
    async (event) => {
      const response = await deliver(pullRequestEvent(), { event });
      await reviewQueue.onIdle();

      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: "ignored", reason: "unsupported-event" });
      expect(github.calls).toEqual([]);
    },
  );

  it("acknowledges and ignores a pull request action that needs no review", async () => {
    const response = await deliver(pullRequestEvent({ action: "labeled" }));
    await reviewQueue.onIdle();

    expect(response.body).toEqual({ status: "ignored", reason: "unsupported-action" });
    expect(github.calls).toEqual([]);
  });

  it("acknowledges and ignores a payload it cannot interpret", async () => {
    const response = await deliver(JSON.stringify({ action: "opened" }));

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: "ignored", reason: "malformed-payload" });
  });

  it("rejects a body above the size limit", async () => {
    const oversized = pullRequestEvent({ padding: "x".repeat(MAX_WEBHOOK_BODY_BYTES) });

    const response = await deliver(oversized);

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "payload_too_large" });
    expect(github.calls).toEqual([]);
  });
});

describe("reviewing through the webhook", () => {
  it("accepts a pull request event, then reviews and comments", async () => {
    const response = await deliver(pullRequestEvent());

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: "queued" });

    await reviewQueue.onIdle();
    expect(github.ownComments).toHaveLength(1);
    expect(github.ownComments[0]?.body).toContain(SUMMARY_MARKER);
    expect(github.ownComments[0]?.body).toContain("**2 findings**");
  });

  it("reviews the pull request as GitHub's API describes it, not as the webhook does", async () => {
    await deliver(pullRequestEvent());
    await reviewQueue.onIdle();

    expect(github.ownComments[0]?.body).not.toMatch(/CANARY/);
    expect(logger.text()).not.toMatch(/CANARY/);
  });

  it("does not review the same delivery twice", async () => {
    const deliveryId = "11111111-1111-4111-8111-111111111111";

    const first = await deliver(pullRequestEvent(), { deliveryId });
    await reviewQueue.onIdle();
    const second = await deliver(pullRequestEvent(), { deliveryId });
    await reviewQueue.onIdle();

    expect(first.body).toEqual({ status: "queued" });
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ status: "duplicate" });
    expect(github.calls.filter((call) => call === "listPullRequestFiles")).toHaveLength(1);
    expect(github.ownComments).toHaveLength(1);
  });

  it("keeps one comment across many events for the same pull request", async () => {
    await deliver(pullRequestEvent({ action: "opened" }));
    await reviewQueue.onIdle();
    await deliver(pullRequestEvent({ action: "synchronize" }));
    await reviewQueue.onIdle();
    github.pullRequest = {
      ...github.pullRequest,
      body: "The author now explains the change in enough detail.",
    };
    await deliver(pullRequestEvent({ action: "edited" }));
    await reviewQueue.onIdle();

    expect(github.ownComments).toHaveLength(1);
    expect(github.ownComments[0]?.body).toContain("**1 finding**");
    expect(github.calls.filter((call) => call === "createComment")).toHaveLength(1);
    expect(github.calls.filter((call) => call === "updateComment")).toHaveLength(2);
  });

  it("turns a burst of events during a review into one further review", async () => {
    let releaseFirstReview: () => void = () => undefined;
    const firstReviewHeld = new Promise<void>((resolve) => {
      releaseFirstReview = resolve;
    });
    github.beforeCall = async (method, callNumber) => {
      if (method === "getPullRequest" && callNumber === 1) {
        await firstReviewHeld;
      }
    };

    const first = await deliver(pullRequestEvent({ action: "opened" }));
    const burst = [];
    for (let push = 0; push < 5; push += 1) {
      burst.push(await deliver(pullRequestEvent({ action: "synchronize" })));
    }
    releaseFirstReview();
    await reviewQueue.onIdle();

    expect(first.body).toEqual({ status: "queued" });
    expect(burst.map((response) => response.body as unknown)).toEqual([
      { status: "queued" },
      { status: "coalesced" },
      { status: "coalesced" },
      { status: "coalesced" },
      { status: "coalesced" },
    ]);
    expect(github.calls.filter((call) => call === "listPullRequestFiles")).toHaveLength(2);
    expect(github.ownComments).toHaveLength(1);
  });

  it("does not publish for a commit that is no longer the head", async () => {
    github.beforeCall = (method, callNumber) => {
      if (method === "getPullRequest" && callNumber === 2) {
        github.pullRequest = { ...github.pullRequest, headSha: NEWER_HEAD_SHA };
      }
    };

    await deliver(pullRequestEvent());
    await reviewQueue.onIdle();

    expect(github.comments).toEqual([]);
  });

  it("logs a failed review without failing the webhook", async () => {
    github.beforeCall = (method) => {
      if (method === "getPullRequest") {
        throw httpError(403, "Resource not accessible by integration");
      }
    };

    const response = await deliver(pullRequestEvent());
    await reviewQueue.onIdle();

    expect(response.status).toBe(202);
    expect(logger.entries.at(-1)).toEqual({
      level: "error",
      message: "Review failed",
      fields: {
        reviewKey: "2002#7",
        rateLimited: false,
        errorName: "Error",
        errorMessage: "Resource not accessible by integration",
        status: 403,
      },
    });
  });

  it("logs a review abandoned because of a rate limit under its own message", async () => {
    github.beforeCall = (method) => {
      if (method === "listPullRequestFiles") {
        throw httpError(429, "API rate limit exceeded");
      }
    };

    await deliver(pullRequestEvent());
    await reviewQueue.onIdle();

    expect(logger.entries.at(-1)).toMatchObject({
      level: "error",
      message: "Review abandoned: GitHub rate limit",
      fields: { reviewKey: "2002#7", rateLimited: true, status: 429 },
    });
  });

  it("lets a delivery whose review failed be redelivered", async () => {
    const deliveryId = "33333333-3333-4333-8333-333333333333";
    let gitHubIsDown = true;
    github.beforeCall = (method) => {
      if (gitHubIsDown && method === "getPullRequest") {
        throw httpError(503);
      }
    };

    const first = await deliver(pullRequestEvent(), { deliveryId });
    await reviewQueue.onIdle();
    gitHubIsDown = false;
    const redelivered = await deliver(pullRequestEvent(), { deliveryId });
    await reviewQueue.onIdle();

    expect(first.body).toEqual({ status: "queued" });
    expect(redelivered.body).toEqual({ status: "queued" });
    expect(github.ownComments).toHaveLength(1);
  });

  it("still treats a delivery whose review succeeded as a duplicate", async () => {
    const deliveryId = "44444444-4444-4444-8444-444444444444";

    await deliver(pullRequestEvent(), { deliveryId });
    await reviewQueue.onIdle();
    const again = await deliver(pullRequestEvent(), { deliveryId });

    expect(again.body).toEqual({ status: "duplicate" });
  });
});

describe("limits", () => {
  it("answers 503 when the queue is full and lets the delivery be sent again", async () => {
    let releaseFirstReview: () => void = () => undefined;
    const firstReviewHeld = new Promise<void>((resolve) => {
      releaseFirstReview = resolve;
    });
    github.beforeCall = async (method, callNumber) => {
      if (method === "getPullRequest" && callNumber === 1) {
        await firstReviewHeld;
      }
    };
    app = buildApp({ concurrency: 1, maxWaiting: 1 });
    const rejectedDeliveryId = "22222222-2222-4222-8222-222222222222";

    const running = await deliver(pullRequestEvent({ number: 1 }));
    const waiting = await deliver(pullRequestEvent({ number: 2 }));
    const rejected = await deliver(pullRequestEvent({ number: 3 }), {
      deliveryId: rejectedDeliveryId,
    });

    expect(running.body).toEqual({ status: "queued" });
    expect(waiting.body).toEqual({ status: "queued" });
    expect(rejected.status).toBe(503);
    expect(rejected.body).toEqual({ error: "queue_full" });

    releaseFirstReview();
    await reviewQueue.onIdle();
    const redelivered = await deliver(pullRequestEvent({ number: 3 }), {
      deliveryId: rejectedDeliveryId,
    });
    await reviewQueue.onIdle();

    expect(redelivered.body).toEqual({ status: "queued" });
  });

  it("answers 503 to an installation with too many reviews waiting, and serves the others", async () => {
    let releaseFirstReview: () => void = () => undefined;
    const firstReviewHeld = new Promise<void>((resolve) => {
      releaseFirstReview = resolve;
    });
    github.beforeCall = async (method, callNumber) => {
      if (method === "getPullRequest" && callNumber === 1) {
        await firstReviewHeld;
      }
    };
    app = buildApp({ concurrency: 1, maxWaiting: 10, maxWaitingPerGroup: 1 });
    const rejectedDeliveryId = "55555555-5555-4555-8555-555555555555";

    const running = await deliver(pullRequestEvent({ number: 1 }));
    const waiting = await deliver(pullRequestEvent({ number: 2 }));
    const rejected = await deliver(pullRequestEvent({ number: 3 }), {
      deliveryId: rejectedDeliveryId,
    });
    const neighbour = await deliver(pullRequestEvent({ number: 4, installation: { id: 9009 } }));

    expect([running.status, waiting.status, neighbour.status]).toEqual([202, 202, 202]);
    expect(rejected.status).toBe(503);
    expect(rejected.body).toEqual({ error: "queue_full" });
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "Webhook rejected: this installation has too many reviews waiting",
      fields: { deliveryId: rejectedDeliveryId, installationId: 1001 },
    });
    expect(logger.text()).not.toContain("CANARY");

    releaseFirstReview();
    await reviewQueue.onIdle();
    const redelivered = await deliver(pullRequestEvent({ number: 3 }), {
      deliveryId: rejectedDeliveryId,
    });
    await reviewQueue.onIdle();

    expect(redelivered.body).toEqual({ status: "queued" });
  });

  it("answers 429 once a client exceeds the rate limit", async () => {
    app = buildApp({ webhookRateLimit: 2 });

    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await deliver(pullRequestEvent({ action: "labeled" }))).status);
    }

    expect(statuses).toEqual([202, 202, 429]);
  });

  it("does not rate-limit the health check", async () => {
    app = buildApp({ webhookRateLimit: 1 });

    await deliver(pullRequestEvent({ action: "labeled" }));
    await deliver(pullRequestEvent({ action: "labeled" }));

    expect((await request(app).get("/healthz")).status).toBe(200);
  });
});

describe("unexpected errors", () => {
  it("answers 500 with a fixed body and logs the cause", async () => {
    const failingStore: DeliveryStore = {
      claim: () => Promise.reject(new Error("storage exploded at /srv/internal/path")),
      release: () => Promise.resolve(),
    };
    app = buildApp({ deliveryStore: failingStore });

    const response = await deliver(pullRequestEvent());

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error" });
    expect(response.text).not.toContain("storage exploded");
    expect(logger.entries.at(-1)).toMatchObject({ level: "error", message: "Request failed" });
  });
});
