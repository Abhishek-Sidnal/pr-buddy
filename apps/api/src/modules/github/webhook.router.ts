import {
  isRateLimitError,
  parsePullRequestEvent,
  verifyWebhookSignature,
} from "@pr-buddy/github-client";
import express, { type RequestHandler, type Router } from "express";
import { describeError, type Logger } from "../../logger.js";
import type { ReviewQueue } from "../reviews/review-queue.js";
import type { ReviewService } from "../reviews/review.service.js";
import type { DeliveryStore } from "./delivery-store.js";

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
    const key = `${trigger.repository.id}#${trigger.pullRequestNumber}`;
    const result = reviewQueue.enqueue(key, async () => {
      try {
        await reviewService.review(trigger);
      } catch (error) {
        // GitHub's "Redeliver" reuses the delivery ID. Forgetting it here is what lets a failed
        // review, for example one that hit a rate limit, be run again by redelivering.
        await deliveryStore.release(deliveryId);
        throw error;
      }
    });
    if (result === "rejected") {
      // Forget the delivery so that GitHub's "Redeliver" can succeed once there is room.
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
