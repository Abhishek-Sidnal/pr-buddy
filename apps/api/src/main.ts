import { createRepositoryClientFactory } from "@pr-buddy/github-client";
import { createApp } from "./app.js";
import { EnvironmentError, loadConfig, type AppConfig } from "./config/env.js";
import { createDatabase, isReachable, type Database } from "./database/database.js";
import { migrate } from "./database/migrate.js";
import { createLogger, describeError, type Logger } from "./logger.js";
import {
  createInMemoryDeliveryStore,
  type DeliveryStore,
} from "./modules/github/delivery-store.js";
import { createPostgresDeliveryStore } from "./modules/github/postgres-delivery-store.js";
import { createReviewErrorLogger } from "./modules/github/webhook.router.js";
import { createPostgresReviewStore } from "./modules/reviews/postgres-review-store.js";
import { createReviewQueue } from "./modules/reviews/review-queue.js";
import { createDiscardingReviewStore, type ReviewStore } from "./modules/reviews/review-store.js";
import { createReviewService } from "./modules/reviews/review.service.js";

/** How long running reviews are given to finish after a shutdown signal. */
const SHUTDOWN_GRACE_MS = 25_000;

function loadConfigOrExit(): AppConfig {
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

interface Storage {
  readonly database?: Database;
  readonly deliveryStore: DeliveryStore;
  readonly reviewStore: ReviewStore;
}

/** Connects to the database and brings its schema up to date, or falls back to memory. */
async function openStorage(config: AppConfig, logger: Logger): Promise<Storage> {
  if (config.database === undefined) {
    logger.info({}, "No database configured: deliveries are kept in memory, history is not kept");
    return {
      deliveryStore: createInMemoryDeliveryStore(),
      reviewStore: createDiscardingReviewStore(),
    };
  }

  const database = createDatabase({
    connectionString: config.database.url,
    poolSize: config.database.poolSize,
    onConnectionError: (error) => {
      logger.error(describeError(error), "Database connection failed");
    },
  });
  const applied = await migrate(database);
  logger.info({ appliedMigrations: applied }, "Database ready");
  return {
    database,
    deliveryStore: createPostgresDeliveryStore(database),
    reviewStore: createPostgresReviewStore(database),
  };
}

const config = loadConfigOrExit();
const logger = createLogger(config.logLevel);

let storage: Storage;
try {
  storage = await openStorage(config, logger);
} catch (error) {
  // Starting without the schema would fail every review later, so stop now and say why.
  logger.error(describeError(error), "Could not prepare the database");
  process.exit(1);
}
const { database } = storage;

const reviewQueue = createReviewQueue({
  concurrency: config.reviewConcurrency,
  maxWaiting: config.reviewQueueLimit,
  onError: createReviewErrorLogger(logger),
});

const app = createApp({
  webhookSecret: config.github.webhookSecret,
  deliveryStore: storage.deliveryStore,
  reviewQueue,
  reviewService: createReviewService({
    clientFactory: createRepositoryClientFactory({
      credentials: { appId: config.github.appId, privateKey: config.github.privateKey },
    }),
    logger,
    reviewStore: storage.reviewStore,
  }),
  logger,
  trustProxy: config.trustProxy,
  webhookRateLimit: config.webhookRateLimit,
  ...(database === undefined ? {} : { isReady: () => isReachable(database) }),
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

  // Stop accepting requests, let reviews in progress publish and be saved, then leave.
  const forceExit = setTimeout(() => {
    logger.warn({}, "Shutdown grace period elapsed; exiting with reviews unfinished");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  server.close(() => {
    void reviewQueue
      .onIdle()
      .then(() => database?.close())
      .finally(() => {
        process.exit(0);
      });
  });
}

process.on("SIGTERM", shutDown);
process.on("SIGINT", shutDown);
process.on("unhandledRejection", (reason) => {
  logger.error(describeError(reason), "Unhandled promise rejection");
});
