/** Identifies one repository as seen by one installation of the app. */
export interface RepositoryTarget {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
}

/** The state of a pull request at the moment it was fetched. */
export interface PullRequestSnapshot {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly baseSha: string;
  readonly headSha: string;
  readonly state: "open" | "closed";
  readonly isDraft: boolean;
  /** Total files changed, which can exceed the number the API will list. */
  readonly changedFileCount: number;
  /** True when the head branch is in another repository. GitHub gives such a run no secrets. */
  readonly isFromFork: boolean;
}

/** One changed file as GitHub reports it, before it is checked for the review engine. */
export interface PullRequestFile {
  readonly path: string;
  readonly previousPath?: string;
  /** GitHub's status string, for example "added", "renamed" or "changed". */
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string;
  /** True when GitHub sent a patch that was not kept because of a size limit. */
  readonly patchOmitted?: boolean;
}

/** Bounds on what one listing of changed files may hold in memory. */
export interface FileListLimits {
  readonly maxFiles: number;
  /** A longer patch is not kept. */
  readonly maxPatchLength: number;
  /** Once kept patches reach this total, no further patch is kept. */
  readonly maxTotalPatchLength: number;
}

/** A comment on a line of a pull request. */
export interface ReviewComment {
  readonly id: number;
  readonly body: string;
}

/** A comment to place on a line of the file as it is after the change. */
export interface NewLineComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

/** One of PR Buddy's own comments on a pull request. */
export interface OwnComment {
  readonly id: number;
  readonly body: string;
}

/** How much one file differs between two commits. */
export interface FileChange {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export type FileLookup =
  | { readonly status: "found"; readonly text: string }
  | { readonly status: "missing" }
  | { readonly status: "too-large" };

/**
 * The GitHub operations PR Buddy needs for one repository. Application code depends on this
 * interface only, so every flow can be tested against an in-memory implementation.
 */
export interface RepositoryClient {
  getPullRequest(pullRequestNumber: number): Promise<PullRequestSnapshot>;
  /**
   * Lists changed files within `limits`. A file whose patch does not fit is still listed, with
   * `patchOmitted` set instead of the patch.
   */
  listPullRequestFiles(
    pullRequestNumber: number,
    limits: FileListLimits,
  ): Promise<PullRequestFile[]>;
  /** Reads a text file at a commit. Files larger than `maxBytes` are not downloaded. */
  getFileText(path: string, ref: string, maxBytes: number): Promise<FileLookup>;
  /** Finds the ID of a comment written by this identity whose body contains `marker`. */
  findOwnComment(pullRequestNumber: number, marker: string): Promise<number | undefined>;
  /** Finds a comment written by this identity whose body contains `marker`, with its text. */
  getOwnComment(pullRequestNumber: number, marker: string): Promise<OwnComment | undefined>;
  /**
   * Lists the files that differ between two commits, with how many lines each gained and lost.
   * Resolves to `undefined` when GitHub cannot compare them, as after a force-push that removed
   * the older commit, or when the list is too long to be complete.
   */
  compareCommits(baseSha: string, headSha: string): Promise<readonly FileChange[] | undefined>;
  createComment(pullRequestNumber: number, body: string): Promise<void>;
  updateComment(commentId: number, body: string): Promise<void>;
  /** Lists the comments this app has placed on lines of the pull request. */
  listOwnReviewComments(pullRequestNumber: number): Promise<ReviewComment[]>;
  /** Posts line comments as one review, so that they send one notification. */
  createReviewWithComments(
    pullRequestNumber: number,
    commitId: string,
    comments: readonly NewLineComment[],
  ): Promise<void>;
  deleteReviewComment(commentId: number): Promise<void>;
}

export type RepositoryClientFactory = (target: RepositoryTarget) => RepositoryClient;
