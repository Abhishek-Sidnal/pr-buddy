import type { PublishAction } from "@pr-buddy/github-client";
import type { ReviewResult } from "@pr-buddy/review-engine";

export type SkipReason = "closed" | "draft" | "stale";

export type RecordedOutcome =
  | {
      readonly status: "completed";
      readonly comment: PublishAction;
      readonly skippedFileCount: number;
      readonly omittedPatchCount: number;
      /** Findings and rule executions. Titles, bodies and patches are not part of it. */
      readonly result: ReviewResult;
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
