import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type {
  FileLookup,
  PullRequestFile,
  RepositoryClient,
  RepositoryClientFactory,
  RepositoryTarget,
  ReviewComment,
} from "./repository-client.js";
import { DEFAULT_RETRY, withRetry, type RetryOptions } from "./retry.js";

const PAGE_SIZE = 100;
/** Comments searched for PR Buddy's own; a pull request with more is not searched further. */
const MAX_COMMENT_PAGES = 10;
const NOT_FOUND = 404;

const ignore = (): void => undefined;
/**
 * Octokit prints failed requests to the console. Every failure is also thrown, and the caller
 * logs it in its own structured format, so Octokit's own output is switched off.
 */
const SILENT_LOG = { debug: ignore, info: ignore, warn: ignore, error: ignore };

export interface GitHubAppCredentials {
  readonly appId: number;
  /** PEM-encoded private key of the GitHub App. */
  readonly privateKey: string;
}

export interface OctokitClientOptions {
  readonly credentials: GitHubAppCredentials;
  readonly retry?: RetryOptions;
  /** Replaces the global `fetch`; used by tests. */
  readonly fetch?: typeof fetch;
}

/**
 * Who PR Buddy is on GitHub for one client: the GitHub App, or a workflow's own token. It
 * decides which comments are "ours". Only those are ever updated or deleted (D-039).
 */
interface CommentIdentity {
  /** Whether a comment on the pull request's conversation was written by this identity. */
  isOwnIssueComment(comment: IssueCommentAuthor): boolean;
  /** The login this identity's line comments carry. */
  getLogin(): Promise<string>;
}

/** The parts of an issue comment that say who wrote it. */
interface IssueCommentAuthor {
  readonly user?: { readonly login: string; readonly type?: string } | null;
  readonly performed_via_github_app?: { readonly id: number; readonly slug?: string } | null;
}

/** What a workflow's `GITHUB_TOKEN` writes as. */
const WORKFLOW_LOGIN = "github-actions[bot]";
const WORKFLOW_APP_SLUG = "github-actions";
/** GitHub lists at most this many files when it compares two commits. */
const MAX_COMPARED_FILES = 300;

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" && error !== null && "status" in error && error.status === status
  );
}

/**
 * The repository a pull request's head branch is in. GitHub's own types say it is always there;
 * it is `null` when that repository, usually a fork, has been deleted.
 */
function headRepositoryOf(head: {
  readonly repo: { readonly full_name: string } | null;
}): string | undefined {
  return head.repo?.full_name;
}

function createRepositoryClient(
  octokit: Octokit,
  target: Pick<RepositoryTarget, "owner" | "repo">,
  identity: CommentIdentity,
  retry: RetryOptions,
): RepositoryClient {
  const { owner, repo } = target;
  const call = <T>(operation: () => Promise<T>): Promise<T> => withRetry(operation, retry);

  const client: RepositoryClient = {
    async getPullRequest(pullRequestNumber) {
      const { data } = await call(() =>
        octokit.rest.pulls.get({ owner, repo, pull_number: pullRequestNumber }),
      );
      return {
        number: data.number,
        title: data.title,
        body: data.body,
        baseSha: data.base.sha,
        headSha: data.head.sha,
        state: data.state,
        isDraft: data.draft ?? false,
        changedFileCount: data.changed_files,
        // A head repository that was deleted counts as a fork: nothing may be assumed about it.
        isFromFork: headRepositoryOf(data.head) !== data.base.repo.full_name,
      };
    },

    async listPullRequestFiles(pullRequestNumber, limits) {
      const limit = limits.maxFiles;
      const files: PullRequestFile[] = [];
      let keptPatchLength = 0;
      for (let page = 1; files.length < limit; page += 1) {
        const { data } = await call(() =>
          octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: pullRequestNumber,
            per_page: PAGE_SIZE,
            page,
          }),
        );
        for (const file of data) {
          // Patches are dropped here, as they arrive, so that a huge pull request never has
          // more than the budget (plus one page) of patch text in memory.
          const { patch } = file;
          const patchFits =
            patch !== undefined &&
            patch.length <= limits.maxPatchLength &&
            keptPatchLength + patch.length <= limits.maxTotalPatchLength;
          if (patchFits) {
            keptPatchLength += patch.length;
          }
          files.push({
            path: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            ...(file.previous_filename === undefined
              ? {}
              : { previousPath: file.previous_filename }),
            ...(patchFits ? { patch } : {}),
            ...(patch !== undefined && !patchFits ? { patchOmitted: true } : {}),
          });
        }
        if (data.length < PAGE_SIZE) {
          break;
        }
      }
      return files.slice(0, limit);
    },

    async getFileText(path, ref, maxBytes): Promise<FileLookup> {
      let data;
      try {
        ({ data } = await call(() => octokit.rest.repos.getContent({ owner, repo, path, ref })));
      } catch (error) {
        if (hasStatus(error, NOT_FOUND)) {
          return { status: "missing" };
        }
        throw error;
      }
      if (Array.isArray(data) || data.type !== "file") {
        return { status: "missing" };
      }
      if (data.size > maxBytes) {
        return { status: "too-large" };
      }
      return { status: "found", text: Buffer.from(data.content, "base64").toString("utf8") };
    },

    async findOwnComment(pullRequestNumber, marker) {
      return (await client.getOwnComment(pullRequestNumber, marker))?.id;
    },

    async getOwnComment(pullRequestNumber, marker) {
      for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
        const { data } = await call(() =>
          octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: pullRequestNumber,
            per_page: PAGE_SIZE,
            page,
          }),
        );
        // A comment by anyone else that copies the marker must not be mistaken for ours.
        const own = data.find(
          (comment) => identity.isOwnIssueComment(comment) && comment.body?.includes(marker),
        );
        if (own !== undefined) {
          return { id: own.id, body: own.body ?? "" };
        }
        if (data.length < PAGE_SIZE) {
          break;
        }
      }
      return undefined;
    },

    async compareCommits(baseSha, headSha) {
      let data;
      try {
        ({ data } = await call(() =>
          octokit.rest.repos.compareCommitsWithBasehead({
            owner,
            repo,
            basehead: `${baseSha}...${headSha}`,
            per_page: 1,
          }),
        ));
      } catch (error) {
        if (hasStatus(error, NOT_FOUND)) {
          return undefined;
        }
        throw error;
      }
      const files = data.files ?? [];
      // A full list may be a cut-off list. An incomplete answer is no answer.
      if (files.length >= MAX_COMPARED_FILES) {
        return undefined;
      }
      return files.map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
      }));
    },

    async createComment(pullRequestNumber, body) {
      await call(() =>
        octokit.rest.issues.createComment({ owner, repo, issue_number: pullRequestNumber, body }),
      );
    },

    async updateComment(commentId, body) {
      await call(() =>
        octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body }),
      );
    },

    async listOwnReviewComments(pullRequestNumber) {
      const login = await identity.getLogin();
      const own: ReviewComment[] = [];
      for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
        const { data } = await call(() =>
          octokit.rest.pulls.listReviewComments({
            owner,
            repo,
            pull_number: pullRequestNumber,
            per_page: PAGE_SIZE,
            page,
          }),
        );
        for (const comment of data) {
          if (comment.user.login === login) {
            own.push({ id: comment.id, body: comment.body });
          }
        }
        if (data.length < PAGE_SIZE) {
          break;
        }
      }
      return own;
    },

    async createReviewWithComments(pullRequestNumber, commitId, comments) {
      await call(() =>
        octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: pullRequestNumber,
          commit_id: commitId,
          event: "COMMENT",
          // RIGHT is the file after the change, the only side a finding points at.
          comments: comments.map((comment) => ({ ...comment, side: "RIGHT" })),
        }),
      );
    },

    async deleteReviewComment(commentId) {
      await call(() =>
        octokit.rest.pulls.deleteReviewComment({ owner, repo, comment_id: commentId }),
      );
    },
  };
  return client;
}

/**
 * Creates repository clients that authenticate as a GitHub App installation. Each installation
 * gets short-lived tokens, issued and refreshed by Octokit; no long-lived token is stored.
 */
export function createRepositoryClientFactory(
  options: OctokitClientOptions,
): RepositoryClientFactory {
  const { appId, privateKey } = options.credentials;
  const retry = options.retry ?? DEFAULT_RETRY;
  const octokitByInstallation = new Map<number, Octokit>();

  function octokitFor(installationId: number): Octokit {
    let octokit = octokitByInstallation.get(installationId);
    if (octokit === undefined) {
      octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId, privateKey, installationId },
        userAgent: "pr-buddy",
        log: SILENT_LOG,
        ...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
      });
      octokitByInstallation.set(installationId, octokit);
    }
    return octokit;
  }

  // Review comments do not say which app wrote them, only which user. An app acts as the user
  // "<slug>[bot]", so its slug is looked up once, authenticated as the app itself.
  let botLogin: Promise<string> | undefined;
  function getBotLogin(): Promise<string> {
    botLogin ??= withRetry(async () => {
      const appOctokit = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId, privateKey },
        userAgent: "pr-buddy",
        log: SILENT_LOG,
        ...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
      });
      const { data } = await appOctokit.rest.apps.getAuthenticated();
      if (data === null) {
        throw new Error("GitHub did not describe the app.");
      }
      return `${data.slug ?? data.name}[bot]`;
    }, retry).catch((error: unknown) => {
      // A failed lookup is not remembered, so the next review tries again.
      botLogin = undefined;
      throw error;
    });
    return botLogin;
  }

  const appIdentity: CommentIdentity = {
    isOwnIssueComment: (comment) => comment.performed_via_github_app?.id === appId,
    getLogin: getBotLogin,
  };

  return (target) =>
    createRepositoryClient(octokitFor(target.installationId), target, appIdentity, retry);
}

export interface WorkflowClientOptions {
  /** The workflow's own token, `GITHUB_TOKEN`. Never logged. */
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly retry?: RetryOptions;
  /** Replaces the global `fetch`; used by tests. */
  readonly fetch?: typeof fetch;
}

/**
 * Creates a repository client that acts with a workflow's own token, for PR Buddy running as a
 * GitHub Action. Its comments appear as GitHub Actions, and "ours" means written by that
 * identity: a comment by a person or by another app is never touched, even if it copies PR
 * Buddy's marker (D-102).
 */
export function createWorkflowRepositoryClient(options: WorkflowClientOptions): RepositoryClient {
  const octokit = new Octokit({
    auth: options.token,
    userAgent: "pr-buddy-runner",
    log: SILENT_LOG,
    ...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
  });
  const workflowIdentity: CommentIdentity = {
    isOwnIssueComment: (comment) =>
      comment.user?.login === WORKFLOW_LOGIN &&
      comment.user.type === "Bot" &&
      comment.performed_via_github_app?.slug === WORKFLOW_APP_SLUG,
    getLogin: () => Promise.resolve(WORKFLOW_LOGIN),
  };
  return createRepositoryClient(
    octokit,
    { owner: options.owner, repo: options.repo },
    workflowIdentity,
    options.retry ?? DEFAULT_RETRY,
  );
}
