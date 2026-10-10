import type { Database, Queryable } from "../../database/database.js";
import type { RecordedOutcome, ReviewRecord, ReviewStore } from "./review-store.js";

/** The columns of `reviews` that depend on how the review ended. */
interface OutcomeColumns {
  readonly skipReason: string | null;
  readonly commentAction: string | null;
  readonly findingCount: number;
  readonly suppressedFindingCount: number;
  readonly skippedFileCount: number;
  readonly omittedPatchCount: number;
  readonly errorName: string | null;
  readonly errorStatus: number | null;
}

const NO_OUTCOME_DETAILS: OutcomeColumns = {
  skipReason: null,
  commentAction: null,
  findingCount: 0,
  suppressedFindingCount: 0,
  skippedFileCount: 0,
  omittedPatchCount: 0,
  errorName: null,
  errorStatus: null,
};

function toOutcomeColumns(outcome: RecordedOutcome): OutcomeColumns {
  switch (outcome.status) {
    case "completed":
      return {
        ...NO_OUTCOME_DETAILS,
        commentAction: outcome.comment,
        findingCount: outcome.result.findings.length,
        suppressedFindingCount: outcome.result.suppressedFindingCount,
        skippedFileCount: outcome.skippedFileCount,
        omittedPatchCount: outcome.omittedPatchCount,
      };
    case "skipped":
      return { ...NO_OUTCOME_DETAILS, skipReason: outcome.reason };
    case "failed":
      return {
        ...NO_OUTCOME_DETAILS,
        errorName: outcome.errorName,
        errorStatus: outcome.errorStatus ?? null,
      };
  }
}

async function upsertRepository(transaction: Queryable, record: ReviewRecord): Promise<void> {
  // The ID is GitHub's and never changes; the owner, name and installation can.
  await transaction.query(
    `INSERT INTO repositories (id, installation_id, owner, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET installation_id = EXCLUDED.installation_id,
           owner           = EXCLUDED.owner,
           name            = EXCLUDED.name,
           updated_at      = now()`,
    [record.repository.id, record.installationId, record.repository.owner, record.repository.name],
  );
}

async function insertReview(transaction: Queryable, record: ReviewRecord): Promise<string> {
  const columns = toOutcomeColumns(record.outcome);
  const inserted = await transaction.query<{ id: string }>(
    `INSERT INTO reviews (
       repository_id, pull_request_number, head_sha, base_sha, status, skip_reason,
       comment_action, finding_count, skipped_file_count, omitted_patch_count,
       error_name, error_status, started_at, completed_at, suppressed_finding_count
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      record.repository.id,
      record.pullRequestNumber,
      record.headSha ?? null,
      record.baseSha ?? null,
      record.outcome.status,
      columns.skipReason,
      columns.commentAction,
      columns.findingCount,
      columns.skippedFileCount,
      columns.omittedPatchCount,
      columns.errorName,
      columns.errorStatus,
      record.startedAt,
      record.completedAt,
      columns.suppressedFindingCount,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new Error("The review row was not returned.");
  }
  return id;
}

async function insertDetails(
  transaction: Queryable,
  reviewId: string,
  outcome: RecordedOutcome,
): Promise<void> {
  if (outcome.status !== "completed") {
    return;
  }
  for (const rule of outcome.result.rules) {
    await transaction.query(
      `INSERT INTO rule_executions
         (review_id, rule_id, rule_version, status, finding_count, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [reviewId, rule.ruleId, rule.ruleVersion, rule.status, rule.findingCount, rule.durationMs],
    );
  }
  for (const [position, finding] of outcome.result.findings.entries()) {
    await transaction.query(
      `INSERT INTO findings (
         review_id, position, rule_id, severity, confidence, message, file_path, line,
         suggestion, evidence
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        reviewId,
        position,
        finding.ruleId,
        finding.severity,
        finding.confidence,
        finding.message,
        finding.filePath ?? null,
        finding.line ?? null,
        finding.suggestion ?? null,
        JSON.stringify(finding.evidence),
      ],
    );
  }

  const { aiReview } = outcome;
  if (aiReview !== undefined) {
    await transaction.query(
      `INSERT INTO ai_reviews (
         review_id, provider, model, status, failure_reason, error_name, finding_count,
         suppressed_finding_count, rejected_finding_count, sent_file_count, omitted_file_count,
         input_tokens, output_tokens, duration_ms
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        reviewId,
        aiReview.provider,
        aiReview.model,
        aiReview.status,
        aiReview.failureReason ?? null,
        aiReview.errorName ?? null,
        aiReview.findingCount,
        aiReview.suppressedFindingCount,
        aiReview.rejectedFindingCount,
        aiReview.sentFileCount,
        aiReview.omittedFileCount,
        aiReview.inputTokens ?? null,
        aiReview.outputTokens ?? null,
        aiReview.durationMs,
      ],
    );
  }
}

/**
 * A review store backed by PostgreSQL. A review, its rule executions and its findings are
 * written in one transaction, so a reader never sees part of a review.
 */
export function createPostgresReviewStore(database: Database): ReviewStore {
  return {
    async save(record) {
      await database.transaction(async (transaction) => {
        await upsertRepository(transaction, record);
        const reviewId = await insertReview(transaction, record);
        await insertDetails(transaction, reviewId, record.outcome);
      });
    },
  };
}
