import type { Queryable } from "../../database/database.js";
import { MAX_PENDING_AGE_SECONDS } from "./pending-review-store.js";

/** Reviews deleted by one statement, so no single statement holds locks for long. */
const BATCH_SIZE = 1_000;
/** Statements in one run. What is left waits for the next run. */
const MAX_BATCHES = 100;

export interface RetentionResult {
  readonly reviewsDeleted: number;
  readonly sessionsDeleted: number;
}

export interface RetentionOptions {
  /** Reviews older than this many days are deleted. Zero keeps every review. */
  readonly retentionDays: number;
  /** Reviews deleted by one statement; smaller in tests. */
  readonly batchSize?: number;
}

/**
 * Deletes what is past its keeping time: reviews older than the retention limit, with their
 * findings, rule executions and AI records, and sessions that have expired. Repositories stay.
 * See docs/DESIGN-STORAGE.md, section 11.
 */
export async function deleteExpiredData(
  database: Queryable,
  options: RetentionOptions,
): Promise<RetentionResult> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  let reviewsDeleted = 0;

  if (options.retentionDays > 0) {
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const deleted = await database.query(
        `DELETE FROM reviews
         WHERE id IN (
           SELECT id FROM reviews
           WHERE started_at < now() - make_interval(days => $1)
           ORDER BY started_at
           LIMIT $2
         )`,
        [options.retentionDays, batchSize],
      );
      reviewsDeleted += deleted.rowCount;
      if (deleted.rowCount < batchSize) {
        break;
      }
    }
  }

  const sessions = await database.query("DELETE FROM sessions WHERE expires_at <= now()");
  // Requests too old to be worth recovering; start-up does the same before it recovers the rest.
  await database.query(
    "DELETE FROM pending_reviews WHERE requested_at <= now() - make_interval(secs => $1)",
    [MAX_PENDING_AGE_SECONDS],
  );
  return { reviewsDeleted, sessionsDeleted: sessions.rowCount };
}
