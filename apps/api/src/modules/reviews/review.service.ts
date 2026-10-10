import {
  publishReviewSummary,
  renderReviewSummary,
  REVIEW_FILE_LIMITS,
  toReviewContext,
  type PublishAction,
  type RepositoryClient,
  type RepositoryClientFactory,
  type ReviewTrigger,
} from "@pr-buddy/github-client";
import { ConfigurationError, createReviewEngine, type ReviewEngine } from "@pr-buddy/review-engine";
import { describeError, type LogFields, type Logger } from "../../logger.js";
import {
  createDiscardingReviewStore,
  type RecordedOutcome,
  type ReviewStore,
  type SkipReason,
} from "./review-store.js";

/** Where a repository keeps its PR Buddy settings. The app is granted read access to this file only. */
export const CONFIGURATION_PATH = ".github/pr-buddy.json";
const MAX_CONFIGURATION_BYTES = 64 * 1_024;

export type ReviewOutcome =
  | { readonly status: "skipped"; readonly reason: SkipReason }
  | {
      readonly status: "completed";
      readonly headSha: string;
      readonly findingCount: number;
      readonly comment: PublishAction;
    };

export interface ReviewService {
  /**
   * Reviews the pull request a webhook pointed at and publishes the result.
   * Rejects if GitHub cannot be reached or the pull request cannot be represented.
   */
  review(trigger: ReviewTrigger): Promise<ReviewOutcome>;
}

export interface ReviewServiceDependencies {
  readonly clientFactory: RepositoryClientFactory;
  readonly logger: Logger;
  /** Where review history is kept. Defaults to keeping none. */
  readonly reviewStore?: ReviewStore;
  /** Replaceable so tests control time. */
  readonly now?: () => Date;
}

interface ConfiguredEngine {
  readonly engine: ReviewEngine;
  /** Why the repository's configuration was not used; empty when it was, or when there is none. */
  readonly configurationIssues: readonly string[];
}

export function createReviewService(dependencies: ReviewServiceDependencies): ReviewService {
  const { clientFactory, logger } = dependencies;
  const reviewStore = dependencies.reviewStore ?? createDiscardingReviewStore();
  const now = dependencies.now ?? ((): Date => new Date());
  const defaultEngine = createReviewEngine();

  /**
   * Builds an engine from the repository's configuration at the base commit. Reading it there,
   * and not at the head, stops a contributor from relaxing the checks on their own pull request.
   */
  async function loadEngine(client: RepositoryClient, baseSha: string): Promise<ConfiguredEngine> {
    const useDefaults = (issue: string): ConfiguredEngine => ({
      engine: defaultEngine,
      configurationIssues: [issue],
    });

    const lookup = await client.getFileText(CONFIGURATION_PATH, baseSha, MAX_CONFIGURATION_BYTES);
    if (lookup.status === "missing") {
      return { engine: defaultEngine, configurationIssues: [] };
    }
    if (lookup.status === "too-large") {
      return useDefaults("The file is larger than 64 KB.");
    }

    let config: unknown;
    try {
      config = JSON.parse(lookup.text);
    } catch {
      return useDefaults("The file is not valid JSON.");
    }
    try {
      return { engine: createReviewEngine({ config }), configurationIssues: [] };
    } catch (error) {
      if (error instanceof ConfigurationError) {
        return { engine: defaultEngine, configurationIssues: error.issues };
      }
      throw error;
    }
  }

  /** What is known about the pull request so far; filled in as the review proceeds. */
  interface Progress {
    headSha?: string;
    baseSha?: string;
  }

  interface Attempt {
    readonly outcome: ReviewOutcome;
    readonly recorded: RecordedOutcome;
  }

  const skipped = (reason: SkipReason, logFields: LogFields): Attempt => {
    logger.info({ ...logFields, reason }, "Review skipped");
    return { outcome: { status: "skipped", reason }, recorded: { status: "skipped", reason } };
  };

  async function attemptReview(trigger: ReviewTrigger, progress: Progress): Promise<Attempt> {
    const { repository, pullRequestNumber } = trigger;
    const client = clientFactory({
      installationId: trigger.installationId,
      owner: repository.owner,
      repo: repository.name,
    });
    const logFields = { repositoryId: repository.id, pullRequestNumber };

    // The webhook is only a trigger: everything reviewed is fetched here, in its current state.
    const pullRequest = await client.getPullRequest(pullRequestNumber);
    progress.headSha = pullRequest.headSha;
    progress.baseSha = pullRequest.baseSha;
    if (pullRequest.state !== "open") {
      return skipped("closed", logFields);
    }
    if (pullRequest.isDraft) {
      return skipped("draft", logFields);
    }

    const files = await client.listPullRequestFiles(pullRequestNumber, REVIEW_FILE_LIMITS);
    const { engine, configurationIssues } = await loadEngine(client, pullRequest.baseSha);
    const { context, skippedFileCount, omittedPatchCount } = toReviewContext(pullRequest, files);
    const result = await engine.review(context);

    // A push may have arrived while the review ran. Its own review is queued behind this one,
    // so this result is dropped instead of being published for a commit that is no longer the
    // head. This narrows the window but cannot close it: a push can still land between this
    // check and the comment call below. The review that push triggers then corrects the comment.
    const latest = await client.getPullRequest(pullRequestNumber);
    if (latest.headSha !== pullRequest.headSha || latest.state !== "open") {
      return skipped("stale", logFields);
    }

    const body = renderReviewSummary(result, {
      skippedFileCount,
      omittedPatchCount,
      unlistedFileCount: Math.max(0, pullRequest.changedFileCount - files.length),
      configurationIssues,
      configurationPath: CONFIGURATION_PATH,
    });
    const comment = await publishReviewSummary(client, pullRequestNumber, body, {
      createIfMissing: result.findings.length > 0 || configurationIssues.length > 0,
    });

    logger.info(
      {
        ...logFields,
        headSha: pullRequest.headSha,
        findingCount: result.findings.length,
        failedRuleCount: result.rules.filter((rule) => rule.status === "failed").length,
        skippedFileCount,
        omittedPatchCount,
        comment,
      },
      "Review completed",
    );
    return {
      outcome: {
        status: "completed",
        headSha: pullRequest.headSha,
        findingCount: result.findings.length,
        comment,
      },
      recorded: { status: "completed", comment, skippedFileCount, omittedPatchCount, result },
    };
  }

  /**
   * Adds the attempt to the history. A failure here is logged and goes no further: by now the
   * comment is on the pull request, and losing a history row must not undo or repeat that.
   */
  async function record(
    trigger: ReviewTrigger,
    progress: Progress,
    startedAt: Date,
    recorded: RecordedOutcome,
  ): Promise<void> {
    try {
      await reviewStore.save({
        installationId: trigger.installationId,
        repository: trigger.repository,
        pullRequestNumber: trigger.pullRequestNumber,
        ...(progress.headSha === undefined ? {} : { headSha: progress.headSha }),
        ...(progress.baseSha === undefined ? {} : { baseSha: progress.baseSha }),
        startedAt,
        completedAt: now(),
        outcome: recorded,
      });
    } catch (error) {
      logger.error(
        {
          repositoryId: trigger.repository.id,
          pullRequestNumber: trigger.pullRequestNumber,
          ...describeError(error),
        },
        "Review could not be saved",
      );
    }
  }

  return {
    async review(trigger) {
      const startedAt = now();
      const progress: Progress = {};
      let attempt: Attempt;
      try {
        attempt = await attemptReview(trigger, progress);
      } catch (error) {
        const { errorName, status } = describeError(error);
        await record(trigger, progress, startedAt, {
          status: "failed",
          errorName: typeof errorName === "string" ? errorName : "Error",
          ...(typeof status === "number" ? { errorStatus: status } : {}),
        });
        throw error;
      }
      await record(trigger, progress, startedAt, attempt.recorded);
      return attempt.outcome;
    },
  };
}
