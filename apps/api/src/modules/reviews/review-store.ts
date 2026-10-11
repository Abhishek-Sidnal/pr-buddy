import type { PublishAction } from "@pr-buddy/github-client";
import type { AiFailureReason, AiReviewStatus } from "@pr-buddy/ai-reviewer";
import type { ReviewResult } from "@pr-buddy/review-engine";

export type SkipReason = "closed" | "draft" | "stale" | "runner";

/**
 * What is kept about an AI review. The text of its suggestions is deliberately not part of it:
 * a model that has read the code may quote it.
 */
export interface AiReviewRecord {
  readonly provider: string;
  readonly model: string;
  readonly status: AiReviewStatus;
  readonly failureReason?: AiFailureReason;
  /** The name of the provider's error, never its message. */
  readonly errorName?: string;
  readonly findingCount: number;
  readonly suppressedFindingCount: number;
  readonly rejectedFindingCount: number;
  readonly sentFileCount: number;
  readonly omittedFileCount: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs: number;
}

export type RecordedOutcome =
  | {
      readonly status: "completed";
      readonly comment: PublishAction;
      readonly skippedFileCount: number;
      readonly omittedPatchCount: number;
      /** Findings and rule executions. Titles, bodies and patches are not part of it. */
      readonly result: ReviewResult;
      /** Present when an AI model was asked. */
      readonly aiReview?: AiReviewRecord;
    }
  | { readonly status: "skipped"; readonly reason: SkipReason }
  | {
      readonly status: "failed";
      /** The error's name and HTTP status only. Its message may quote things best not kept. */
      readonly errorName: string;
      readonly errorStatus?: number;
    };

/** One review attempt, as kept for history. */
export interface ReviewRecord {
  readonly installationId: number;
  readonly repository: {
    readonly id: number;
    readonly owner: string;
    readonly name: string;
  };
  readonly pullRequestNumber: number;
  /** Absent when the review failed before the pull request could be fetched. */
  readonly headSha?: string;
  readonly baseSha?: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly outcome: RecordedOutcome;
}

/** Keeps the history of reviews. */
export interface ReviewStore {
  save(record: ReviewRecord): Promise<void>;
}

/** Used when no database is configured: history is simply not kept. */
export function createDiscardingReviewStore(): ReviewStore {
  return { save: () => Promise.resolve() };
}
