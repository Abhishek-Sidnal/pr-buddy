import type {
  FileChange,
  FileLookup,
  PullRequestFile,
  PullRequestSnapshot,
  RepositoryClient,
} from "@pr-buddy/github-client";

export const BASE_SHA = "a".repeat(40);
export const HEAD_SHA = "b".repeat(40);
export const OLDER_SHA = "c".repeat(40);
export const NEWER_SHA = "d".repeat(40);

interface StoredComment {
  id: number;
  body: string;
  /** Whether the workflow's own identity wrote it. */
  isOwn: boolean;
}

/** An error shaped like the ones the GitHub client throws for HTTP failures. */
export function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${String(status)} ERROR-MESSAGE-CANARY`), { status });
}

/**
 * An in-memory repository with one pull request, seen through a workflow's token. Tests set its
 * fields to describe a scenario and read them afterwards to see what the runner did.
 */
export class FakeRepository {
  pullRequest: PullRequestSnapshot = {
    number: 7,
    title: "TITLE-CANARY",
    body: "Adds a feature, explains why it is needed and describes how it was tested.",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    state: "open",
    isDraft: false,
    changedFileCount: 2,
    isFromFork: false,
  };

  files: PullRequestFile[] = [
    { path: "src/feature.ts", status: "added", additions: 10, deletions: 0 },
    { path: "src/feature.test.ts", status: "added", additions: 12, deletions: 0 },
  ];

  /** The configuration file at the base commit. */
  configuration: FileLookup = {
    status: "found",
    text: JSON.stringify({ review: { mode: "runner" } }),
  };

  comments: StoredComment[] = [];
  readonly comparisons = new Map<string, readonly FileChange[]>();
  /** Every call, in order, as "method" or "method argument". */
  readonly calls: string[] = [];
  /** Makes a method fail: the error is thrown each time it is called. */
  readonly failures = new Map<keyof RepositoryClient, Error>();
  /** Runs before a call returns, to change the scenario mid-run. */
  beforeCall: (method: keyof RepositoryClient, callNumber: number) => void = () => undefined;

  #counts = new Map<string, number>();

  #enter(method: keyof RepositoryClient, detail?: string): void {
    this.calls.push(detail === undefined ? method : `${method} ${detail}`);
    const count = (this.#counts.get(method) ?? 0) + 1;
    this.#counts.set(method, count);
    this.beforeCall(method, count);
    const failure = this.failures.get(method);
    if (failure !== undefined) {
      throw failure;
    }
  }

  setConfiguration(config: unknown): void {
    this.configuration = { status: "found", text: JSON.stringify(config) };
  }

  /** A pull request with nothing for the rules to report. */
  makeClean(): void {
    this.files = [
      { path: "src/feature.ts", status: "added", additions: 10, deletions: 0 },
      { path: "src/feature.test.ts", status: "added", additions: 12, deletions: 0 },
    ];
  }

  /** A pull request without a description: one finding. */
  makeFinding(): void {
    this.pullRequest = { ...this.pullRequest, body: null };
  }

  get ownComments(): StoredComment[] {
    return this.comments.filter((comment) => comment.isOwn);
  }

  readonly client: RepositoryClient = {
    getPullRequest: () => {
      this.#enter("getPullRequest");
      return Promise.resolve(this.pullRequest);
    },
    listPullRequestFiles: (_number, limits) => {
      this.#enter("listPullRequestFiles");
      return Promise.resolve(this.files.slice(0, limits.maxFiles));
    },
    getFileText: (path, ref) => {
      this.#enter("getFileText", `${path}@${ref}`);
      return Promise.resolve(this.configuration);
    },
    findOwnComment: (_number, marker) => {
      this.#enter("findOwnComment");
      return Promise.resolve(
        this.comments.find((comment) => comment.isOwn && comment.body.includes(marker))?.id,
      );
    },
    getOwnComment: (_number, marker) => {
      this.#enter("getOwnComment");
      const own = this.comments.find((comment) => comment.isOwn && comment.body.includes(marker));
      return Promise.resolve(own === undefined ? undefined : { id: own.id, body: own.body });
    },
    compareCommits: (baseSha, headSha) => {
      this.#enter("compareCommits", `${baseSha}...${headSha}`);
      return Promise.resolve(this.comparisons.get(`${baseSha}...${headSha}`));
    },
    createComment: (_number, body) => {
      this.#enter("createComment");
      this.comments.push({ id: this.comments.length + 1, body, isOwn: true });
      return Promise.resolve();
    },
    updateComment: (commentId, body) => {
      this.#enter("updateComment");
      const comment = this.comments.find((candidate) => candidate.id === commentId);
      if (!comment?.isOwn) {
        return Promise.reject(httpError(404));
      }
      comment.body = body;
      return Promise.resolve();
    },
    listOwnReviewComments: () => {
      this.#enter("listOwnReviewComments");
      return Promise.resolve([]);
    },
    createReviewWithComments: () => {
      this.#enter("createReviewWithComments");
      return Promise.resolve();
    },
    deleteReviewComment: () => {
      this.#enter("deleteReviewComment");
      return Promise.resolve();
    },
  };
}
