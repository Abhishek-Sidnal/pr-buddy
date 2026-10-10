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

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" && error !== null && "status" in error && error.status === status
  );
}

function createRepositoryClient(
  octokit: Octokit,
  target: RepositoryTarget,
  appId: number,
  retry: RetryOptions,
  getBotLogin: () => Promise<string>,
): RepositoryClient {
  const { owner, repo } = target;
  const call = <T>(operation: () => Promise<T>): Promise<T> => withRetry(operation, retry);

  return {
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
          (comment) =>
            comment.performed_via_github_app?.id === appId && comment.body?.includes(marker),
        );
        if (own !== undefined) {
          return own.id;
        }
        if (data.length < PAGE_SIZE) {
          break;
        }
      }
      return undefined;
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
      const login = await getBotLogin();
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

  return (target) =>
    createRepositoryClient(octokitFor(target.installationId), target, appId, retry, getBotLogin);
}
