import {
  isRateLimitError,
  parseInstallationEvent,
  parsePullRequestEvent,
  verifyWebhookSignature,
  type ReviewTrigger,
} from "@pr-buddy/github-client";
import express, { type RequestHandler, type Router } from "express";
import { describeError, type Logger } from "../../logger.js";
import {
  createForgetfulPendingReviewStore,
  type PendingReview,
  type PendingReviewStore,
} from "../reviews/pending-review-store.js";
import type { EnqueueResult, ReviewQueue } from "../reviews/review-queue.js";
import type { ReviewService } from "../reviews/review.service.js";
import type { DeliveryStore } from "./delivery-store.js";
import { createIdleInstallationStore, type InstallationStore } from "./installation-store.js";

/** Pull request events are tens of kilobytes; anything near this limit is not one. */
export const MAX_WEBHOOK_BODY_BYTES = 1_024 * 1_024;

/** GitHub sends a GUID. The pattern is deliberately loose but bounded. */
const DELIVERY_ID = /^[0-9A-Za-z-]{8,64}$/;

export interface WebhookRouterDependencies {
  readonly webhookSecret: string;
  readonly deliveryStore: DeliveryStore;
  readonly reviewQueue: ReviewQueue;
  readonly reviewService: ReviewService;
  readonly logger: Logger;
  /** Remembers requested reviews across restarts. Defaults to remembering nothing. */
  readonly pendingReviewStore?: PendingReviewStore;
  /** Cleans up when the app is uninstalled or suspended. Defaults to doing nothing. */
  readonly installationStore?: InstallationStore;
}

const INSTALLATION_EVENTS = new Set(["installation", "installation_repositories"]);

export interface ReviewDispatchDependencies {
  readonly reviewQueue: ReviewQueue;
  readonly reviewService: ReviewService;
  readonly pendingReviewStore: PendingReviewStore;
}

/**
 * Puts a requested review on the queue. When it finishes its record is forgotten; when it fails
 * the failure is counted, `onFailure` runs, and the error goes on to the queue's error handler.
 */
export function dispatchReview(
  dependencies: ReviewDispatchDependencies,
  pending: PendingReview,
  onFailure: () => Promise<void> = () => Promise.resolve(),
): EnqueueResult {
  const { reviewQueue, reviewService, pendingReviewStore } = dependencies;
  const { trigger } = pending;
  return reviewQueue.enqueue(reviewKeyOf(trigger), async () => {
    try {
      await reviewService.review(trigger);
    } catch (error) {
      await pendingReviewStore.recordFailure(pending);
      await onFailure();
      throw error;
    }
    await pendingReviewStore.complete(pending);
  });
}

function reviewKeyOf(trigger: ReviewTrigger): string {
  return `${trigger.repository.id}#${trigger.pullRequestNumber}`;
}

function parseJson(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body.toString("utf8")) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Handles `POST /webhooks/github`. The order of the checks matters: nothing in the body is
 * trusted, or even parsed, until its signature has been verified.
 */
export function createWebhookRouter(dependencies: WebhookRouterDependencies): Router {
  const { webhookSecret, deliveryStore, reviewQueue, reviewService, logger } = dependencies;
  const pendingReviewStore = dependencies.pendingReviewStore ?? createForgetfulPendingReviewStore();
  const installationStore = dependencies.installationStore ?? createIdleInstallationStore();
  const dispatch = { reviewQueue, reviewService, pendingReviewStore };

  const handleWebhook: RequestHandler = async (request, response) => {
    const rawBody: unknown = request.body;
    const signature = request.get("x-hub-signature-256");
    if (!Buffer.isBuffer(rawBody) || !verifyWebhookSignature(webhookSecret, rawBody, signature)) {
      logger.warn({ ip: request.ip }, "Webhook rejected: invalid signature");
      response.status(401).json({ error: "invalid_signature" });
      return;
    }

    const deliveryId = request.get("x-github-delivery");
    if (deliveryId === undefined || !DELIVERY_ID.test(deliveryId)) {
      response.status(400).json({ error: "invalid_delivery_id" });
      return;
    }

    const event = request.get("x-github-event");
    if (event === "ping") {
      response.status(200).json({ status: "pong" });
      return;
    }
    if (event !== undefined && INSTALLATION_EVENTS.has(event)) {
      const body = parseJson(rawBody);
      const change = parseInstallationEvent(event, body.ok ? body.value : undefined);
      if (change.kind === "ignored") {
        response.status(202).json({ status: "ignored", reason: "unsupported-action" });
        return;
      }
      // Applying a change twice removes nothing more, so a redelivery needs no special care.
      const cleanup = await installationStore.apply(change);
      logger.info(
        { deliveryId, change: change.kind, installationId: change.installationId, ...cleanup },
        "Installation changed",
      );
      response.status(200).json({ status: "applied" });
      return;
    }
    if (event !== "pull_request") {
      response.status(202).json({ status: "ignored", reason: "unsupported-event" });
      return;
    }

    if (!(await deliveryStore.claim(deliveryId))) {
      logger.info({ deliveryId }, "Webhook ignored: duplicate delivery");
      response.status(202).json({ status: "duplicate" });
      return;
    }

    const payload = parseJson(rawBody);
    if (!payload.ok) {
      response.status(400).json({ error: "invalid_json" });
      return;
    }
    const parsed = parsePullRequestEvent(payload.value);
    if (parsed.kind === "ignored") {
      response.status(202).json({ status: "ignored", reason: parsed.reason });
      return;
    }

    const { trigger } = parsed;
    // Written before the request is acknowledged: from here on a restart cannot lose the review.
    const pending = { trigger, generation: await pendingReviewStore.add(trigger) };
    const result = dispatchReview(dispatch, pending, () =>
      // GitHub's "Redeliver" reuses the delivery ID. Forgetting it here is what lets a failed
      // review, for example one that hit a rate limit, be run again by redelivering.
      deliveryStore.release(deliveryId),
    );
    if (result === "rejected") {
      // Forget the request and the delivery, so that GitHub's "Redeliver" can succeed once
      // there is room.
      await pendingReviewStore.complete(pending);
      await deliveryStore.release(deliveryId);
      logger.warn({ deliveryId }, "Webhook rejected: review queue is full");
      response.status(503).json({ error: "queue_full" });
      return;
    }

    logger.info(
      {
        deliveryId,
        action: trigger.action,
        repositoryId: trigger.repository.id,
        pullRequestNumber: trigger.pullRequestNumber,
        result,
      },
      "Review requested",
    );
    response.status(202).json({ status: result });
  };

  const router = express.Router();
  router.post(
    "/",
    // Every content type is read as raw bytes: the signature covers the body exactly as sent.
    express.raw({ type: () => true, limit: MAX_WEBHOOK_BODY_BYTES }),
    handleWebhook,
  );
  return router;
}

/**
 * Logs a review that failed. Passed to the queue as its error handler. A review given up because
 * of a rate limit is logged under its own message, so that it can be found and redelivered.
 */
export function createReviewErrorLogger(logger: Logger): (error: unknown, key: string) => void {
  return (error, key) => {
    const rateLimited = isRateLimitError(error);
    logger.error(
      { reviewKey: key, rateLimited, ...describeError(error) },
      rateLimited ? "Review abandoned: GitHub rate limit" : "Review failed",
    );
  };
}

/**
 * Queues the reviews that were requested before the service last stopped and never finished.
 * Called once at start-up. Returns how many were queued.
 */
export async function recoverPendingReviews(
  dependencies: ReviewDispatchDependencies & { readonly logger: Logger },
): Promise<number> {
  const pending = await dependencies.pendingReviewStore.takeRecoverable();
  let queued = 0;
  for (const review of pending) {
    // One that does not fit stays in the table and is picked up at the next start.
    if (dispatchReview(dependencies, review) !== "rejected") {
      queued += 1;
    }
  }
  if (pending.length > 0) {
    dependencies.logger.info(
      { found: pending.length, queued },
      "Recovered reviews that were requested before the last stop",
    );
  }
  return queued;
}
