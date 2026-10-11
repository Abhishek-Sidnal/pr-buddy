import type { Database } from "../../database/database.js";

/** How many reviews ended in each way. */
export interface OutcomeCounts {
  readonly completed: number;
  readonly skipped: number;
  readonly failed: number;
}

/** One installation as the operator sees it: its account and counts, nothing it reviewed. */
export interface InstallationActivity {
  readonly installationId: number;
  /** The account the app is installed on. */
  readonly account: string;
  readonly repositoryCount: number;
  /** Reviews in the last 30 days. */
  readonly reviewCount: number;
  /** Of those, the ones that failed. */
  readonly failedCount: number;
  /** ISO 8601, or `null` if nothing was reviewed. */
  readonly lastReviewAt: string | null;
  /** The provider of its own AI key, or `null` if it has none. */
  readonly aiProvider: string | null;
}

/**
 * What the whole service has been doing. It holds account names and counts only: no repository
 * name, pull request, finding, file path, login or key (D-092).
 */
export interface OperatorOverview {
  readonly totals: {
    /** Installations with at least one reviewed repository. */
    readonly installations: number;
    readonly repositories: number;
    /** People whose session has not ended. */
    readonly people: number;
  };
  readonly reviews: {
    readonly day: OutcomeCounts;
    readonly week: OutcomeCounts;
    readonly month: OutcomeCounts;
  };
  /** AI reviews in the last 30 days. */
  readonly aiReviews: OutcomeCounts;
  /** Reviews that were requested and have not finished. */
  readonly pending: { readonly count: number; readonly oldestRequestedAt: string | null };
  readonly keysByProvider: readonly { readonly provider: string; readonly count: number }[];
  /** The most recently active installations, at most `MAX_INSTALLATIONS`. */
  readonly installations: readonly InstallationActivity[];
}

/**
 * Reads across every installation. Every other store limits its reads to the installations of
 * a session (D-054); this one must not be given to anything but the operator's router.
 */
export interface OperatorStore {
  getOverview(): Promise<OperatorOverview>;
}

export const MAX_INSTALLATIONS = 100;

type Outcome = keyof OutcomeCounts;

function emptyCounts(): Record<Outcome, number> {
  return { completed: 0, skipped: 0, failed: 0 };
}

/** An operator store backed by PostgreSQL. It takes no input from a request. */
export function createPostgresOperatorStore(database: Database): OperatorStore {
  return {
    async getOverview() {
      const [totals, reviews, aiReviews, keys, installations] = await Promise.all([
        database.query<{
          installations: string;
          repositories: string;
          people: string;
          pending: string;
          oldest_pending: Date | null;
        }>(
          `SELECT
             (SELECT count(DISTINCT installation_id) FROM repositories) AS installations,
             (SELECT count(*) FROM repositories) AS repositories,
             (SELECT count(DISTINCT user_id) FROM sessions WHERE expires_at > now()) AS people,
             (SELECT count(*) FROM pending_reviews) AS pending,
             (SELECT min(requested_at) FROM pending_reviews) AS oldest_pending`,
        ),
        database.query<{ status: Outcome; day: string; week: string; month: string }>(
          `SELECT status,
                  count(*) FILTER (WHERE started_at > now() - interval '1 day') AS day,
                  count(*) FILTER (WHERE started_at > now() - interval '7 days') AS week,
                  count(*) AS month
           FROM reviews
           WHERE started_at > now() - interval '30 days'
           GROUP BY status`,
        ),
        database.query<{ status: Outcome; count: string }>(
          `SELECT a.status, count(*) AS count
           FROM ai_reviews a
           JOIN reviews r ON r.id = a.review_id
           WHERE r.started_at > now() - interval '30 days'
           GROUP BY a.status`,
        ),
        database.query<{ provider: string; count: string }>(
          `SELECT provider, count(*) AS count
           FROM installation_ai_keys
           GROUP BY provider
           ORDER BY provider`,
        ),
        database.query<{
          installation_id: string;
          account: string;
          repository_count: string;
          review_count: string;
          failed_count: string;
          last_review_at: Date | null;
          ai_provider: string | null;
        }>(
          `SELECT p.installation_id,
                  min(p.owner) AS account,
                  count(DISTINCT p.id) AS repository_count,
                  count(r.id) FILTER (WHERE r.started_at > now() - interval '30 days')
                    AS review_count,
                  count(r.id) FILTER (
                    WHERE r.status = 'failed' AND r.started_at > now() - interval '30 days'
                  ) AS failed_count,
                  max(r.started_at) AS last_review_at,
                  k.provider AS ai_provider
           FROM repositories p
           LEFT JOIN reviews r ON r.repository_id = p.id
           LEFT JOIN installation_ai_keys k ON k.installation_id = p.installation_id
           GROUP BY p.installation_id, k.provider
           ORDER BY max(r.started_at) DESC NULLS LAST, p.installation_id
           LIMIT $1`,
          [MAX_INSTALLATIONS],
        ),
      ]);

      const day = emptyCounts();
      const week = emptyCounts();
      const month = emptyCounts();
      for (const row of reviews.rows) {
        day[row.status] = Number(row.day);
        week[row.status] = Number(row.week);
        month[row.status] = Number(row.month);
      }
      const ai = emptyCounts();
      for (const row of aiReviews.rows) {
        ai[row.status] = Number(row.count);
      }
      const total = totals.rows[0];

      return {
        totals: {
          installations: Number(total?.installations ?? 0),
          repositories: Number(total?.repositories ?? 0),
          people: Number(total?.people ?? 0),
        },
        reviews: { day, week, month },
        aiReviews: ai,
        pending: {
          count: Number(total?.pending ?? 0),
          oldestRequestedAt: total?.oldest_pending?.toISOString() ?? null,
        },
        keysByProvider: keys.rows.map((row) => ({
          provider: row.provider,
          count: Number(row.count),
        })),
        installations: installations.rows.map((row) => ({
          installationId: Number(row.installation_id),
          account: row.account,
          repositoryCount: Number(row.repository_count),
          reviewCount: Number(row.review_count),
          failedCount: Number(row.failed_count),
          lastReviewAt: row.last_review_at?.toISOString() ?? null,
          aiProvider: row.ai_provider,
        })),
      };
    },
  };
}
