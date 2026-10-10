import { Router, type Response } from "express";
import { z } from "zod";
import { sessionOf } from "../auth/auth.router.js";
import type { HistoryStore, ReviewCursor } from "./history-store.js";

const NOT_FOUND = 404;
const BAD_REQUEST = 400;

/** GitHub's repository IDs are positive whole numbers. */
const repositoryIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .transform(Number);
const reviewIdSchema = z.uuid();
const statusSchema = z.enum(["completed", "skipped", "failed"]);

/**
 * A cursor is the time and ID of the last review on the previous page, joined by `~`. It comes
 * back from the browser, so both halves are checked before they reach a query.
 */
const cursorSchema = z
  .string()
  .max(100)
  .transform((value, context): ReviewCursor => {
    const [time, id, ...rest] = value.split("~");
    const startedAt = new Date(time ?? "");
    const parsedId = reviewIdSchema.safeParse(id);
    if (rest.length > 0 || Number.isNaN(startedAt.getTime()) || !parsedId.success) {
      context.addIssue({ code: "custom", message: "is not a cursor" });
      return z.NEVER;
    }
    return { startedAt, id: parsedId.data };
  });

function encodeCursor(cursor: ReviewCursor | null): string | null {
  return cursor === null ? null : `${cursor.startedAt.toISOString()}~${cursor.id}`;
}

function notFound(response: Response): void {
  response.status(NOT_FOUND).json({ error: "not_found" });
}

/**
 * The read API of the dashboard. It must be mounted behind `createRequireSession`: every handler
 * reads the session from the response and passes its installations to the store.
 */
export function createHistoryRouter(historyStore: HistoryStore): Router {
  const router = Router();

  router.get("/me", (_request, response) => {
    const session = sessionOf(response.locals);
    response.json({
      login: session.login,
      installationCount: session.installationIds.length,
      expiresAt: session.expiresAt.toISOString(),
    });
  });

  router.get("/overview", async (_request, response) => {
    const { installationIds } = sessionOf(response.locals);
    response.json(await historyStore.getOverview(installationIds));
  });

  router.get("/repositories", async (_request, response) => {
    const { installationIds } = sessionOf(response.locals);
    response.json({ repositories: await historyStore.listRepositories(installationIds) });
  });

  router.get("/repositories/:repositoryId/reviews", async (request, response) => {
    const repositoryId = repositoryIdSchema.safeParse(request.params.repositoryId);
    if (!repositoryId.success) {
      notFound(response);
      return;
    }
    const rawCursor = request.query["cursor"];
    const cursor = rawCursor === undefined ? undefined : cursorSchema.safeParse(rawCursor);
    if (cursor !== undefined && !cursor.success) {
      response.status(BAD_REQUEST).json({ error: "invalid_cursor" });
      return;
    }

    const { installationIds } = sessionOf(response.locals);
    const page = await historyStore.listReviews(installationIds, repositoryId.data, cursor?.data);
    if (page === undefined) {
      notFound(response);
      return;
    }
    response.json({ ...page, nextCursor: encodeCursor(page.nextCursor) });
  });

  router.get("/reviews", async (request, response) => {
    const rawStatus = request.query["status"];
    const status = rawStatus === undefined ? undefined : statusSchema.safeParse(rawStatus);
    if (status !== undefined && !status.success) {
      response.status(BAD_REQUEST).json({ error: "invalid_status" });
      return;
    }
    const rawCursor = request.query["cursor"];
    const cursor = rawCursor === undefined ? undefined : cursorSchema.safeParse(rawCursor);
    if (cursor !== undefined && !cursor.success) {
      response.status(BAD_REQUEST).json({ error: "invalid_cursor" });
      return;
    }

    const { installationIds } = sessionOf(response.locals);
    const page = await historyStore.listAllReviews(installationIds, {
      status: status?.data,
      cursor: cursor?.data,
    });
    response.json({ ...page, nextCursor: encodeCursor(page.nextCursor) });
  });

  router.get("/reviews/:reviewId", async (request, response) => {
    const reviewId = reviewIdSchema.safeParse(request.params.reviewId);
    if (!reviewId.success) {
      notFound(response);
      return;
    }
    const { installationIds } = sessionOf(response.locals);
    const review = await historyStore.getReview(installationIds, reviewId.data);
    if (review === undefined) {
      notFound(response);
      return;
    }
    response.json(review);
  });

  return router;
}
