import type { Queryable } from "../../database/database.js";
import { toBigintArrayLiteral } from "../auth/postgres-session-store.js";
import {
  MAX_REPOSITORIES,
  OVERVIEW_DAYS,
  RECENT_REVIEW_COUNT,
  REVIEW_PAGE_SIZE,
  type HistoryStore,
  type RepositoryRef,
  type ReviewCursor,
  type ReviewListing,
  type ReviewStatus,
  type ReviewSummary,
  type StoredAiReview,
  type StoredFinding,
  type StoredRuleExecution,
} from "./history-store.js";

/**
 * The start of every review query. The join to `repositories` and the installation filter are
 * part of it, so no caller can select a review without them. `$1` is always the installations.
 */
const SELECT_REVIEWS = `
  SELECT r.id, r.repository_id, p.owner, p.name, r.pull_request_number, r.head_sha, r.base_sha,
         r.status, r.skip_reason, r.comment_action, r.finding_count, r.suppressed_finding_count,
         r.skipped_file_count, r.omitted_patch_count, r.error_name, r.error_status,
         r.started_at, r.completed_at, a.finding_count AS ai_finding_count
  FROM reviews r
  JOIN repositories p ON p.id = r.repository_id
  LEFT JOIN ai_reviews a ON a.review_id = r.id
  WHERE p.installation_id = ANY($1::bigint[])`;

interface ReviewRow {
  readonly id: string;
  readonly repository_id: string;
  readonly owner: string;
  readonly name: string;
  readonly pull_request_number: number;
  readonly head_sha: string | null;
  readonly base_sha: string | null;
  readonly status: ReviewStatus;
  readonly skip_reason: string | null;
  readonly comment_action: string | null;
  readonly finding_count: number;
  readonly suppressed_finding_count: number;
  readonly skipped_file_count: number;
  readonly omitted_patch_count: number;
  readonly error_name: string | null;
  readonly error_status: number | null;
  readonly started_at: Date;
  readonly completed_at: Date;
  readonly ai_finding_count: number | null;
}

function toSummary(row: ReviewRow): ReviewSummary {
  return {
    id: row.id,
    // PostgreSQL returns bigint as text; GitHub's IDs fit in a JavaScript number.
    repository: { id: Number(row.repository_id), owner: row.owner, name: row.name },
    pullRequestNumber: row.pull_request_number,
    headSha: row.head_sha,
    status: row.status,
    skipReason: row.skip_reason,
    findingCount: row.finding_count,
    suppressedFindingCount: row.suppressed_finding_count,
    aiFindingCount: row.ai_finding_count,
    startedAt: row.started_at.toISOString(),
    durationMs: row.completed_at.getTime() - row.started_at.getTime(),
  };
}

const toCount = (value: string | null): number => Number(value ?? 0);
const toNullableCount = (value: string | null): number | null =>
  value === null ? null : Number(value);

/** A history store backed by PostgreSQL. Every statement is limited to the given installations. */
export function createPostgresHistoryStore(database: Queryable): HistoryStore {
  async function findRepository(
    installations: string,
    repositoryId: number,
  ): Promise<RepositoryRef | undefined> {
    const result = await database.query<{ id: string; owner: string; name: string }>(
      `SELECT id, owner, name FROM repositories
       WHERE id = $2 AND installation_id = ANY($1::bigint[])`,
      [installations, repositoryId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { id: Number(row.id), owner: row.owner, name: row.name };
  }

  /**
   * One page of reviews, newest first. The statement is fixed text: a filter that is not wanted
   * is passed as NULL and switches itself off.
   */
  async function selectPage(
    installations: string,
    filter: {
      readonly repositoryId?: number | undefined;
      readonly status?: ReviewStatus | undefined;
      readonly cursor?: ReviewCursor | undefined;
    },
  ): Promise<ReviewListing> {
    // One more than a page is read, to learn whether another page follows.
    const result = await database.query<ReviewRow>(
      `${SELECT_REVIEWS}
         AND ($2::bigint IS NULL OR r.repository_id = $2::bigint)
         AND ($3::text IS NULL OR r.status = $3::text)
         AND ($4::timestamptz IS NULL OR (r.started_at, r.id) < ($4::timestamptz, $5::uuid))
       ORDER BY r.started_at DESC, r.id DESC
       LIMIT $6`,
      [
        installations,
        filter.repositoryId ?? null,
        filter.status ?? null,
        filter.cursor?.startedAt ?? null,
        filter.cursor?.id ?? null,
        REVIEW_PAGE_SIZE + 1,
      ],
    );
    const page = result.rows.slice(0, REVIEW_PAGE_SIZE);
    const last = page.at(-1);
    return {
      reviews: page.map(toSummary),
      nextCursor:
        result.rows.length > REVIEW_PAGE_SIZE && last !== undefined
          ? { startedAt: last.started_at, id: last.id }
          : null,
    };
  }

  return {
    async getOverview(installationIds) {
      const installations = toBigintArrayLiteral(installationIds);
      const totals = await database.query<{
        since: Date;
        repository_count: string;
        review_count: string;
        completed_count: string;
        skipped_count: string;
        failed_count: string;
        finding_count: string | null;
      }>(
        `SELECT now() - make_interval(days => $2) AS since,
                (SELECT count(*) FROM repositories
                 WHERE installation_id = ANY($1::bigint[])) AS repository_count,
                count(r.id) AS review_count,
                count(r.id) FILTER (WHERE r.status = 'completed') AS completed_count,
                count(r.id) FILTER (WHERE r.status = 'skipped') AS skipped_count,
                count(r.id) FILTER (WHERE r.status = 'failed') AS failed_count,
                sum(r.finding_count) AS finding_count
         FROM repositories p
         JOIN reviews r ON r.repository_id = p.id
                       AND r.started_at >= now() - make_interval(days => $2)
         WHERE p.installation_id = ANY($1::bigint[])`,
        [installations, OVERVIEW_DAYS],
      );
      const recent = await database.query<ReviewRow>(
        `${SELECT_REVIEWS} ORDER BY r.started_at DESC, r.id DESC LIMIT $2`,
        [installations, RECENT_REVIEW_COUNT],
      );
      const row = totals.rows[0];
      return {
        since: (row?.since ?? new Date()).toISOString(),
        repositoryCount: toCount(row?.repository_count ?? null),
        reviewCount: toCount(row?.review_count ?? null),
        completedCount: toCount(row?.completed_count ?? null),
        skippedCount: toCount(row?.skipped_count ?? null),
        failedCount: toCount(row?.failed_count ?? null),
        findingCount: toCount(row?.finding_count ?? null),
        recentReviews: recent.rows.map(toSummary),
      };
    },

    async listRepositories(installationIds) {
      const result = await database.query<{
        id: string;
        owner: string;
        name: string;
        review_count: string;
        last_reviewed_at: Date | null;
        last_status: ReviewStatus | null;
      }>(
        `SELECT p.id, p.owner, p.name,
                (SELECT count(*) FROM reviews WHERE repository_id = p.id) AS review_count,
                latest.started_at AS last_reviewed_at,
                latest.status AS last_status
         FROM repositories p
         LEFT JOIN LATERAL (
           SELECT started_at, status FROM reviews
           WHERE repository_id = p.id
           ORDER BY started_at DESC, id DESC
           LIMIT 1
         ) latest ON true
         WHERE p.installation_id = ANY($1::bigint[])
         ORDER BY lower(p.owner), lower(p.name), p.id
         LIMIT $2`,
        [toBigintArrayLiteral(installationIds), MAX_REPOSITORIES],
      );
      return result.rows.map((row) => ({
        id: Number(row.id),
        owner: row.owner,
        name: row.name,
        reviewCount: toCount(row.review_count),
        lastReviewedAt: row.last_reviewed_at?.toISOString() ?? null,
        lastStatus: row.last_status,
      }));
    },

    async listReviews(installationIds, repositoryId, cursor) {
      const installations = toBigintArrayLiteral(installationIds);
      const repository = await findRepository(installations, repositoryId);
      if (repository === undefined) {
        return undefined;
      }
      return { repository, ...(await selectPage(installations, { repositoryId, cursor })) };
    },

    listAllReviews(installationIds, filter = {}) {
      return selectPage(toBigintArrayLiteral(installationIds), filter);
    },

    async getReview(installationIds, reviewId) {
      const found = await database.query<ReviewRow>(`${SELECT_REVIEWS} AND r.id = $2::uuid`, [
        toBigintArrayLiteral(installationIds),
        reviewId,
      ]);
      const row = found.rows[0];
      if (row === undefined) {
        return undefined;
      }

      // A later review of the same pull request at another commit makes this one out of date.
      const newer = await database.query<{ id: string }>(
        `SELECT id FROM reviews
         WHERE repository_id = $1 AND pull_request_number = $2
           AND status = 'completed'
           AND started_at > $3
           AND head_sha IS DISTINCT FROM $4
         ORDER BY started_at DESC, id DESC
         LIMIT 1`,
        [Number(row.repository_id), row.pull_request_number, row.started_at, row.head_sha],
      );

      // The review is visible, so its details are too: they hang off its ID alone.
      const findings = await database.query<{
        rule_id: string;
        severity: string;
        confidence: number;
        message: string;
        file_path: string | null;
        line: number | null;
        suggestion: string | null;
        evidence: StoredFinding["evidence"];
      }>(
        `SELECT rule_id, severity, confidence, message, file_path, line, suggestion, evidence
         FROM findings WHERE review_id = $1::uuid ORDER BY position`,
        [row.id],
      );
      const rules = await database.query<{
        rule_id: string;
        rule_version: string;
        status: string;
        finding_count: number;
        duration_ms: number;
      }>(
        `SELECT rule_id, rule_version, status, finding_count, duration_ms
         FROM rule_executions WHERE review_id = $1::uuid ORDER BY rule_id`,
        [row.id],
      );
      // The provider's error name stays with operators; the reason is enough for a reader.
      const ai = await database.query<{
        provider: string;
        model: string;
        status: string;
        failure_reason: string | null;
        finding_count: number;
        suppressed_finding_count: number;
        rejected_finding_count: number;
        sent_file_count: number;
        omitted_file_count: number;
        input_tokens: string | null;
        output_tokens: string | null;
        duration_ms: number;
      }>(
        `SELECT provider, model, status, failure_reason, finding_count, suppressed_finding_count,
                rejected_finding_count, sent_file_count, omitted_file_count, input_tokens,
                output_tokens, duration_ms
         FROM ai_reviews WHERE review_id = $1::uuid`,
        [row.id],
      );
      const aiRow = ai.rows[0];
      const aiReview: StoredAiReview | null =
        aiRow === undefined
          ? null
          : {
              provider: aiRow.provider,
              model: aiRow.model,
              status: aiRow.status,
              failureReason: aiRow.failure_reason,
              findingCount: aiRow.finding_count,
              suppressedFindingCount: aiRow.suppressed_finding_count,
              rejectedFindingCount: aiRow.rejected_finding_count,
              sentFileCount: aiRow.sent_file_count,
              omittedFileCount: aiRow.omitted_file_count,
              inputTokens: toNullableCount(aiRow.input_tokens),
              outputTokens: toNullableCount(aiRow.output_tokens),
              durationMs: aiRow.duration_ms,
            };

      return {
        ...toSummary(row),
        baseSha: row.base_sha,
        commentAction: row.comment_action,
        skippedFileCount: row.skipped_file_count,
        omittedPatchCount: row.omitted_patch_count,
        errorName: row.error_name,
        errorStatus: row.error_status,
        findings: findings.rows.map((finding): StoredFinding => ({
          ruleId: finding.rule_id,
          severity: finding.severity,
          confidence: finding.confidence,
          message: finding.message,
          filePath: finding.file_path,
          line: finding.line,
          suggestion: finding.suggestion,
          evidence: finding.evidence,
        })),
        rules: rules.rows.map((rule): StoredRuleExecution => ({
          ruleId: rule.rule_id,
          ruleVersion: rule.rule_version,
          status: rule.status,
          findingCount: rule.finding_count,
          durationMs: rule.duration_ms,
        })),
        aiReview,
        newerReviewId: newer.rows[0]?.id ?? null,
      };
    },
  };
}
