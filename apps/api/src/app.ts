import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { UserAuthClient } from "@pr-buddy/github-client";
import type { OperatorInfo } from "./config/env.js";
import { describeError, type Logger } from "./logger.js";
import type { AiKeyStore } from "./modules/ai-keys/ai-key-store.js";
import { createAiKeyRouter } from "./modules/ai-keys/ai-key.router.js";
import { createAuthRouter, createRequireSession } from "./modules/auth/auth.router.js";
import type { SessionStore } from "./modules/auth/session-store.js";
import {
  createWebhookRouter,
  type WebhookRouterDependencies,
} from "./modules/github/webhook.router.js";
import type { HistoryStore } from "./modules/history/history-store.js";
import { createHistoryRouter } from "./modules/history/history.router.js";
import { createWebRouter, setDashboardHeaders } from "./modules/web/web.router.js";

const ONE_MINUTE_MS = 60_000;
const BAD_REQUEST = 400;
const PAYLOAD_TOO_LARGE = 413;
const SERVICE_UNAVAILABLE = 503;

export interface AppDependencies extends WebhookRouterDependencies {
  /** Number of reverse proxies in front of the service; 0 when it is reached directly. */
  readonly trustProxy: number;
  /** Webhook requests allowed per minute from one client address. */
  readonly webhookRateLimit: number;
  /** Reports whether the service's dependencies are reachable. Must not throw. Defaults to yes. */
  readonly isReady?: () => Promise<boolean>;
  /** Sign-in, the read API and the web application. Without it none of their routes exist. */
  readonly dashboard?: DashboardDependencies;
}

export interface DashboardDependencies {
  readonly authClient: UserAuthClient;
  readonly sessionStore: SessionStore;
  readonly historyStore: HistoryStore;
  /** The origin people use to reach the service, without a trailing slash. */
  readonly publicUrl: string;
  /** The app's name in github.com/apps/<slug>, if the operator configured it. */
  readonly appSlug?: string;
  /** Who runs this deployment, if the operator said so. */
  readonly operator?: OperatorInfo;
  /** Days a review is kept; 0 keeps them for ever. */
  readonly retentionDays?: number;
  /** Folder holding the built web application. */
  readonly webRoot: string;
  /** Sign-in requests allowed per minute from one client address. */
  readonly authRateLimit: number;
  /** Read requests allowed per minute from one client address. */
  readonly apiRateLimit: number;
  /** Lets owners store their installation's AI key. Without it those routes do not exist. */
  readonly aiKeys?: {
    readonly aiKeyStore: AiKeyStore;
    /** Replaces the global `fetch` for the request that checks a key; used by tests. */
    readonly fetch?: typeof fetch;
  };
}

const setSecurityHeaders: RequestHandler = (_request, response, next) => {
  response.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  next();
};

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

const setStrictTransportSecurity: RequestHandler = (_request, response, next) => {
  response.set("Strict-Transport-Security", `max-age=${ONE_YEAR_SECONDS}`);
  next();
};

const notFound: RequestHandler = (_request, response) => {
  response.status(404).json({ error: "not_found" });
};

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" && error !== null && "status" in error && error.status === status
  );
}

function isPayloadTooLarge(error: unknown): boolean {
  return hasStatus(error, PAYLOAD_TOO_LARGE);
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
    // A body that is not the JSON it claims to be is the sender's mistake, not a fault here.
    if (hasStatus(error, BAD_REQUEST)) {
      response.status(BAD_REQUEST).json({ error: "bad_request" });
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
  // The service speaks plain HTTP to a proxy; over a public HTTPS address, browsers are told to
  // stay on HTTPS. Never for http://localhost, where it would lock a developer out.
  if (dependencies.dashboard?.publicUrl.startsWith("https://") === true) {
    app.use(setStrictTransportSecurity);
  }

  // Liveness: the process is up.
  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  // Readiness: the process can do its work, which includes reaching the database if there is one.
  app.get("/readyz", async (_request, response) => {
    const ready = await (dependencies.isReady?.() ?? Promise.resolve(true));
    response
      .status(ready ? 200 : SERVICE_UNAVAILABLE)
      .json({ status: ready ? "ready" : "unavailable" });
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

  const { dashboard } = dependencies;
  if (dashboard !== undefined) {
    const perMinute = (limit: number): RequestHandler =>
      rateLimit({
        windowMs: ONE_MINUTE_MS,
        limit,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: "rate_limited" },
      });
    app.use(
      "/auth",
      perMinute(dashboard.authRateLimit),
      createAuthRouter({ ...dashboard, logger: dependencies.logger }),
    );
    // An unknown path under /api is an error in JSON, never the web page.
    app.use(
      "/api",
      perMinute(dashboard.apiRateLimit),
      createRequireSession(dashboard.sessionStore, dashboard.publicUrl),
      createHistoryRouter(dashboard.historyStore),
      ...(dashboard.aiKeys === undefined
        ? []
        : [
            createAiKeyRouter({
              ...dashboard.aiKeys,
              logger: dependencies.logger,
              publicUrl: dashboard.publicUrl,
            }),
          ]),
      notFound,
    );
    app.use(setDashboardHeaders, createWebRouter(dashboard.webRoot));
  }

  app.use(notFound);
  app.use(createErrorHandler(dependencies.logger));
  return app;
}
