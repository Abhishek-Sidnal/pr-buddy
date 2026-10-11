import { Router } from "express";
import type { Logger } from "../../logger.js";
import { sessionOf } from "../auth/auth.router.js";
import type { ReviewQueue } from "../reviews/review-queue.js";
import type { OperatorStore } from "./operator-store.js";

export interface OperatorRouterDependencies {
  readonly operatorStore: OperatorStore;
  /** GitHub's numeric IDs of the people who run this deployment. */
  readonly operatorUserIds: readonly number[];
  /** The queue of this process, for what is running and waiting now. */
  readonly reviewQueue: Pick<ReviewQueue, "running" | "waiting">;
  readonly logger: Logger;
}

const NOT_FOUND = 404;

/** Whether a GitHub user is one of the people who run this deployment. */
export function isOperator(userId: number, operatorUserIds: readonly number[]): boolean {
  return operatorUserIds.includes(userId);
}

/**
 * What the operator may see about the whole service. It must be mounted behind
 * `createRequireSession`. Anyone who is not an operator gets the answer an unknown path gets,
 * so the route does not even confirm that it exists. See docs/DESIGN-OPERATIONS.md, section 5.
 */
export function createOperatorRouter(dependencies: OperatorRouterDependencies): Router {
  const { operatorStore, operatorUserIds, reviewQueue, logger } = dependencies;
  const router = Router();

  router.use("/operator", (_request, response, next) => {
    const { userId } = sessionOf(response.locals);
    if (!isOperator(userId, operatorUserIds)) {
      response.status(NOT_FOUND).json({ error: "not_found" });
      return;
    }
    next();
  });

  router.get("/operator/overview", async (_request, response) => {
    const overview = await operatorStore.getOverview();
    logger.info({ userId: sessionOf(response.locals).userId }, "Operator overview read");
    response.json({
      generatedAt: new Date().toISOString(),
      ...overview,
      queue: { running: reviewQueue.running, waiting: reviewQueue.waiting },
    });
  });

  return router;
}
