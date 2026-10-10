import { createRepositoryClientFactory } from "@pr-buddy/github-client";
import { createApp } from "./app.js";
import { EnvironmentError, loadConfig } from "./config/env.js";
import { createLogger, describeError } from "./logger.js";
import { createInMemoryDeliveryStore } from "./modules/github/delivery-store.js";
import { createReviewErrorLogger } from "./modules/github/webhook.router.js";
import { createReviewQueue } from "./modules/reviews/review-queue.js";
import { createReviewService } from "./modules/reviews/review.service.js";

/** How long running reviews are given to finish after a shutdown signal. */
const SHUTDOWN_GRACE_MS = 25_000;

function loadConfigOrExit(): ReturnType<typeof loadConfig> {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof EnvironmentError) {
      // The logger is not configured yet, and this message contains variable names only.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadConfigOrExit();
const logger = createLogger(config.logLevel);

const reviewQueue = createReviewQueue({
  concurrency: config.reviewConcurrency,
  maxWaiting: config.reviewQueueLimit,
  onError: createReviewErrorLogger(logger),
});

const app = createApp({
  webhookSecret: config.github.webhookSecret,
  deliveryStore: createInMemoryDeliveryStore(),
  reviewQueue,
  reviewService: createReviewService({
    clientFactory: createRepositoryClientFactory({
      credentials: { appId: config.github.appId, privateKey: config.github.privateKey },
    }),
    logger,
  }),
  logger,
  trustProxy: config.trustProxy,
  webhookRateLimit: config.webhookRateLimit,
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "PR Buddy API is listening");
});

let isShuttingDown = false;

function shutDown(signal: string): void {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  logger.info(
    { signal, running: reviewQueue.running, waiting: reviewQueue.waiting },
    "Shutting down",
  );

  // Stop accepting requests, let reviews in progress publish, then leave.
  const forceExit = setTimeout(() => {
    logger.warn({}, "Shutdown grace period elapsed; exiting with reviews unfinished");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  server.close(() => {
    void reviewQueue.onIdle().then(() => {
      process.exit(0);
    });
  });
}

process.on("SIGTERM", shutDown);
process.on("SIGINT", shutDown);
process.on("unhandledRejection", (reason) => {
  logger.error(describeError(reason), "Unhandled promise rejection");
});
