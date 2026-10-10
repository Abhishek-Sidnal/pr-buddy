import type { ReviewTrigger } from "@pr-buddy/github-client";
import type { Queryable } from "../../database/database.js";

/** A review that was requested and has not finished. */
export interface PendingReview {
  readonly trigger: ReviewTrigger;
  /** Which request for this pull request the review answers; see `PendingReviewStore.add`. */
  readonly generation: number;
}

/**
 * Remembers reviews between the moment a webhook asks for one and the moment it finishes, so
 * that a restart in between does not lose it. See docs/DESIGN-STORAGE.md, section 10.
 */
export interface PendingReviewStore {
  /**
   * Records a request. A second request for the same pull request replaces the first and gets
   * the next generation.
   */
  add(trigger: ReviewTrigger): Promise<number>;
  /** Forgets a request whose review finished, unless a newer request has replaced it. */
  complete(pending: PendingReview): Promise<void>;
  /** Notes that a review of this request failed. */
  recordFailure(pending: PendingReview): Promise<void>;
  /** Drops requests that are too old or failed too often, and returns the rest, oldest first. */
  takeRecoverable(): Promise<readonly PendingReview[]>;
}

/** Used when no database is configured: nothing is remembered, so nothing can be recovered. */
export function createForgetfulPendingReviewStore(): PendingReviewStore {
  let generation = 0;
  return {
    add() {
      generation += 1;
      return Promise.resolve(generation);
    },
    complete: () => Promise.resolve(),
    recordFailure: () => Promise.resolve(),
    takeRecoverable: () => Promise.resolve([]),
  };
}

/** A review is retried at most this many times across restarts. */
export const MAX_PENDING_ATTEMPTS = 3;
/** A request older than this is dropped: the pull request has moved on. */
export const MAX_PENDING_AGE_SECONDS = 24 * 60 * 60;
/** Requests recovered at one start-up. More than this would only fill the queue. */
const MAX_RECOVERED = 1_000;

interface PendingRow {
  readonly repository_id: string;
  readonly pull_request_number: number;
  readonly installation_id: string;
  readonly owner: string;
  readonly name: string;
  readonly action: string;
  readonly generation: number;
}

/** A pending-review store backed by the `pending_reviews` table. */
export function createPostgresPendingReviewStore(database: Queryable): PendingReviewStore {
  const keyOf = ({ trigger }: PendingReview): [number, number] => [
    trigger.repository.id,
    trigger.pullRequestNumber,
  ];

  return {
    async add(trigger) {
      const result = await database.query<{ generation: number }>(
        `INSERT INTO pending_reviews
           (repository_id, pull_request_number, installation_id, owner, name, action)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (repository_id, pull_request_number) DO UPDATE
           SET installation_id = EXCLUDED.installation_id,
               owner           = EXCLUDED.owner,
               name            = EXCLUDED.name,
               action          = EXCLUDED.action,
               generation      = pending_reviews.generation + 1,
               attempts        = 0,
               requested_at    = now()
         RETURNING generation`,
        [
          trigger.repository.id,
          trigger.pullRequestNumber,
          trigger.installationId,
          trigger.repository.owner,
          trigger.repository.name,
          trigger.action,
        ],
      );
      const generation = result.rows[0]?.generation;
      if (generation === undefined) {
        throw new Error("The pending review was not returned.");
      }
      return generation;
    },

    async complete(pending) {
      await database.query(
        `DELETE FROM pending_reviews
         WHERE repository_id = $1 AND pull_request_number = $2 AND generation = $3`,
        [...keyOf(pending), pending.generation],
      );
    },

    async recordFailure(pending) {
      await database.query(
        `UPDATE pending_reviews SET attempts = attempts + 1
         WHERE repository_id = $1 AND pull_request_number = $2 AND generation = $3`,
        [...keyOf(pending), pending.generation],
      );
    },

    async takeRecoverable() {
      await database.query(
        `DELETE FROM pending_reviews
         WHERE attempts >= $1 OR requested_at <= now() - make_interval(secs => $2)`,
        [MAX_PENDING_ATTEMPTS, MAX_PENDING_AGE_SECONDS],
      );
      const result = await database.query<PendingRow>(
        `SELECT repository_id, pull_request_number, installation_id, owner, name, action,
                generation
         FROM pending_reviews
         ORDER BY requested_at, repository_id, pull_request_number
         LIMIT $1`,
        [MAX_RECOVERED],
      );
      return result.rows.map((row) => ({
        generation: row.generation,
        trigger: {
          // The action is only logged; whatever it was, the review fetches the current state.
          action: row.action as ReviewTrigger["action"],
          // PostgreSQL returns bigint as text; GitHub's IDs fit in a JavaScript number.
          installationId: Number(row.installation_id),
          repository: { id: Number(row.repository_id), owner: row.owner, name: row.name },
          pullRequestNumber: row.pull_request_number,
        },
      }));
    },
  };
}
