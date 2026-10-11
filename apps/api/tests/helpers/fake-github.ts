import type {
  FileChange,
  FileListLimits,
  FileLookup,
  PullRequestFile,
  PullRequestSnapshot,
  RepositoryClient,
  RepositoryClientFactory,
  RepositoryTarget,
} from "@pr-buddy/github-client";

export const BASE_SHA = "a".repeat(40);
export const HEAD_SHA = "b".repeat(40);
export const NEWER_HEAD_SHA = "c".repeat(40);

export interface FakeComment {
  readonly id: number;
  body: string;
  /** False for a comment written by a person or by another app. */
  readonly byThisApp: boolean;
}

export interface FakeLineComment {
  readonly id: number;
  readonly byThisApp: boolean;
  readonly commitId: string;
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

type ClientMethod = keyof RepositoryClient;

/**
 * An in-memory GitHub repository holding one pull request. Tests change its public fields to set
 * up a scenario and read them afterwards to see what PR Buddy did.
 */
export class FakeGitHub {
  pullRequest: PullRequestSnapshot = {
    number: 7,
    title: "Add a feature",
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

  /** Result of reading the configuration file; `refs` records the commits it was read at. */
  configuration: FileLookup = { status: "missing" };
  readonly configurationRefs: string[] = [];
  /** The limits each file listing was asked to respect. */
  readonly fileListLimits: FileListLimits[] = [];

  comments: FakeComment[] = [];
  /** What comparing two commits answers, keyed by "<older>...<newer>". Absent: not comparable. */
  readonly comparisons = new Map<string, readonly FileChange[]>();
  /** Comments placed on lines of the pull request. */
  lineComments: FakeLineComment[] = [];
  #nextLineCommentId = 100;
  /** Every client method called, in order. */
  readonly calls: ClientMethod[] = [];
  /** Every repository a client was created for. */
  readonly targets: RepositoryTarget[] = [];

  /** Runs before each client call. Tests use it to change state mid-review or to fail a call. */
  beforeCall: (method: ClientMethod, callNumber: number) => void | Promise<void> = () => undefined;

  readonly clientFactory: RepositoryClientFactory = (target) => {
    this.targets.push(target);
    return this.#client;
  };

  async #enter(method: ClientMethod): Promise<void> {
    this.calls.push(method);
    await this.beforeCall(method, this.calls.filter((call) => call === method).length);
  }

  readonly #client: RepositoryClient = {
    getPullRequest: async () => {
      await this.#enter("getPullRequest");
      return this.pullRequest;
    },
    listPullRequestFiles: async (_number, limits) => {
      await this.#enter("listPullRequestFiles");
      this.fileListLimits.push(limits);
      return this.files.slice(0, limits.maxFiles);
    },
    getFileText: async (_path, ref) => {
      await this.#enter("getFileText");
      this.configurationRefs.push(ref);
      return this.configuration;
    },
    findOwnComment: async (_number, marker) => {
      await this.#enter("findOwnComment");
      return this.comments.find((comment) => comment.byThisApp && comment.body.includes(marker))
        ?.id;
    },
    getOwnComment: async (_number, marker) => {
      await this.#enter("getOwnComment");
      const own = this.comments.find(
        (comment) => comment.byThisApp && comment.body.includes(marker),
      );
      return own === undefined ? undefined : { id: own.id, body: own.body };
    },
    compareCommits: async (baseSha, headSha) => {
      await this.#enter("compareCommits");
      return this.comparisons.get(`${baseSha}...${headSha}`);
    },
    createComment: async (_number, body) => {
      await this.#enter("createComment");
      this.comments.push({ id: this.comments.length + 1, body, byThisApp: true });
    },
    updateComment: async (commentId, body) => {
      await this.#enter("updateComment");
      const comment = this.comments.find((candidate) => candidate.id === commentId);
      if (comment === undefined) {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }
      comment.body = body;
    },
    listOwnReviewComments: async () => {
      await this.#enter("listOwnReviewComments");
      return this.lineComments
        .filter((comment) => comment.byThisApp)
        .map(({ id, body }) => ({ id, body }));
    },
    createReviewWithComments: async (_number, commitId, comments) => {
      await this.#enter("createReviewWithComments");
      for (const comment of comments) {
        this.#nextLineCommentId += 1;
        this.lineComments.push({
          id: this.#nextLineCommentId,
          byThisApp: true,
          commitId,
          path: comment.path,
          line: comment.line,
          body: comment.body,
        });
      }
    },
    deleteReviewComment: async (commentId) => {
      await this.#enter("deleteReviewComment");
      this.lineComments = this.lineComments.filter((comment) => comment.id !== commentId);
    },
  };

  /** Comments written by PR Buddy. */
  get ownComments(): FakeComment[] {
    return this.comments.filter((comment) => comment.byThisApp);
  }

  setConfiguration(config: unknown): void {
    this.configuration = { status: "found", text: JSON.stringify(config) };
  }
}

/** An error shaped like the ones the GitHub client throws for HTTP failures. */
export function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}
