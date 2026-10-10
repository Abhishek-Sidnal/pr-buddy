import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { describeError, type Logger } from "./logger.js";
import {
  createWebhookRouter,
  type WebhookRouterDependencies,
} from "./modules/github/webhook.router.js";

const ONE_MINUTE_MS = 60_000;
const PAYLOAD_TOO_LARGE = 413;

export interface AppDependencies extends WebhookRouterDependencies {
  /** Number of reverse proxies in front of the service; 0 when it is reached directly. */
  readonly trustProxy: number;
  /** Webhook requests allowed per minute from one client address. */
  readonly webhookRateLimit: number;
}

const setSecurityHeaders: RequestHandler = (_request, response, next) => {
  response.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  next();
};

const notFound: RequestHandler = (_request, response) => {
  response.status(404).json({ error: "not_found" });
};

function isPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === PAYLOAD_TOO_LARGE
  );
}

/** Turns any error into a fixed JSON response. Details go to the log, never to the client. */
function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (isPayloadTooLarge(error)) {
      response.status(PAYLOAD_TOO_LARGE).json({ error: "payload_too_large" });
      return;
    }
    logger.error(describeError(error), "Request failed");
    response.status(500).json({ error: "internal_error" });
  };
}

/** Builds the HTTP application. It does not listen; `main.ts` and the tests decide how to serve it. */
export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", dependencies.trustProxy);
  app.use(setSecurityHeaders);

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.use(
    "/webhooks/github",
    rateLimit({
      windowMs: ONE_MINUTE_MS,
      limit: dependencies.webhookRateLimit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "rate_limited" },
    }),
    createWebhookRouter(dependencies),
  );

  app.use(notFound);
  app.use(createErrorHandler(dependencies.logger));
  return app;
}
