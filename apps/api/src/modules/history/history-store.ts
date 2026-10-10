/**
 * What the dashboard can read. These are the shapes sent to the browser, so they hold nothing the
 * database does not: no titles, descriptions, patches or AI suggestion text.
 */

export type ReviewStatus = "completed" | "skipped" | "failed";

export interface RepositoryRef {
  /** GitHub's repository ID. */
  readonly id: number;
  readonly owner: string;
  readonly name: string;
}

export interface ReviewSummary {
  readonly id: string;
  readonly repository: RepositoryRef;
  readonly pullRequestNumber: number;
  /** `null` when the review failed before the pull request could be fetched. */
  readonly headSha: string | null;
  readonly status: ReviewStatus;
  readonly skipReason: string | null;
  readonly findingCount: number;
  readonly suppressedFindingCount: number;
  /** `null` when no AI model was asked. */
  readonly aiFindingCount: number | null;
  /** ISO 8601. */
  readonly startedAt: string;
  readonly durationMs: number;
}

export interface StoredFinding {
  readonly ruleId: string;
  readonly severity: string;
  readonly confidence: number;
  readonly message: string;
  readonly filePath: string | null;
  readonly line: number | null;
  readonly suggestion: string | null;
  readonly evidence: readonly { readonly label: string; readonly value: string }[];
}

export interface StoredRuleExecution {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly status: string;
  readonly findingCount: number;
  readonly durationMs: number;
}

export interface StoredAiReview {
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly failureReason: string | null;
  readonly findingCount: number;
  readonly suppressedFindingCount: number;
  readonly rejectedFindingCount: number;
  readonly sentFileCount: number;
  readonly omittedFileCount: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly durationMs: number;
}

export interface ReviewDetails extends ReviewSummary {
  readonly baseSha: string | null;
  readonly commentAction: string | null;
  readonly skippedFileCount: number;
  readonly omittedPatchCount: number;
  readonly errorName: string | null;
  readonly errorStatus: number | null;
  readonly findings: readonly StoredFinding[];
  readonly rules: readonly StoredRuleExecution[];
  readonly aiReview: StoredAiReview | null;
  /**
   * The latest review of the same pull request at another commit, when there is one: this
   * review then describes code that has since changed.
   */
  readonly newerReviewId: string | null;
}

/** One page of reviews, newest first. */
export interface ReviewListing {
  readonly reviews: readonly ReviewSummary[];
  /** `null` on the last page. */
  readonly nextCursor: ReviewCursor | null;
}

export interface ReviewPage extends ReviewListing {
  readonly repository: RepositoryRef;
}

export interface RepositorySummary extends RepositoryRef {
  readonly reviewCount: number;
  /** ISO 8601; `null` when the repository has no reviews. */
  readonly lastReviewedAt: string | null;
  readonly lastStatus: ReviewStatus | null;
}

export interface Overview {
  /** Start of the period the totals cover, ISO 8601. */
  readonly since: string;
  readonly repositoryCount: number;
  readonly reviewCount: number;
  readonly completedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly findingCount: number;
  readonly recentReviews: readonly ReviewSummary[];
}

/** Where a page of reviews ended: the next page starts after this review. */
export interface ReviewCursor {
  readonly startedAt: Date;
  readonly id: string;
}

/**
 * Reads review history. Every method takes the installations the caller may see and can return
 * nothing outside them; what is hidden is indistinguishable from what does not exist.
 */
export interface HistoryStore {
  getOverview(installationIds: readonly number[]): Promise<Overview>;
  listRepositories(installationIds: readonly number[]): Promise<readonly RepositorySummary[]>;
  /** `undefined` when the repository is not visible. */
  listReviews(
    installationIds: readonly number[],
    repositoryId: number,
    cursor?: ReviewCursor,
  ): Promise<ReviewPage | undefined>;
  /** Reviews of every visible repository, optionally with one outcome only. */
  listAllReviews(
    installationIds: readonly number[],
    filter?: {
      readonly status?: ReviewStatus | undefined;
      readonly cursor?: ReviewCursor | undefined;
    },
  ): Promise<ReviewListing>;
  /** `undefined` when the review is not visible. */
  getReview(
    installationIds: readonly number[],
    reviewId: string,
  ): Promise<ReviewDetails | undefined>;
}

export const REVIEW_PAGE_SIZE = 25;
export const RECENT_REVIEW_COUNT = 10;
export const OVERVIEW_DAYS = 30;
/** Repositories listed for one person. */
export const MAX_REPOSITORIES = 500;
