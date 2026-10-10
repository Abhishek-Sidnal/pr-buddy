import {
  publishInlineComments,
  publishReviewSummary,
  renderReviewSummary,
  REVIEW_FILE_LIMITS,
  toReviewContext,
  type PublishAction,
  type RepositoryClient,
  type RepositoryClientFactory,
  type ReviewTrigger,
} from "@pr-buddy/github-client";
import { parseAiSettings, type AiReview, type AiReviewer } from "@pr-buddy/ai-reviewer";
import {
  ConfigurationError,
  createReviewEngine,
  parseReviewContext,
  type ReviewEngine,
} from "@pr-buddy/review-engine";
import { describeError, type LogFields, type Logger } from "../../logger.js";
import {
  createDiscardingReviewStore,
  type AiReviewRecord,
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
      /** Suggestions an AI model contributed. Absent when no model was asked. */
      readonly aiFindingCount?: number;
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
  /**
   * Asks an AI model for suggestions, for repositories that enabled it. Without one, no pull
   * request content leaves the service.
   */
  readonly aiReviewer?: AiReviewer;
  /** Replaceable so tests control time. */
  readonly now?: () => Date;
}

/**
 * Separates the `ai` section from the settings of the review engine, which knows nothing about
 * AI and would reject the section as an unknown field.
 */
function splitConfiguration(config: unknown): { ai: unknown; engineConfig: unknown } {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return { ai: undefined, engineConfig: config };
  }
  const { ai, ...engineConfig } = config as Record<string, unknown>;
  return { ai, engineConfig };
}

/** Reduces an AI review to what is kept: identifiers, counts and timings, never its text. */
function toAiReviewRecord(reviewer: AiReviewer, review: AiReview): AiReviewRecord {
  return {
    provider: reviewer.provider,
    model: reviewer.model,
    status: review.status,
    ...(review.failureReason === undefined ? {} : { failureReason: review.failureReason }),
    ...(review.errorName === undefined ? {} : { errorName: review.errorName }),
    findingCount: review.findings.length,
    suppressedFindingCount: review.suppressedFindingCount,
    rejectedFindingCount: review.rejectedFindingCount,
    sentFileCount: review.sentFileCount,
    omittedFileCount: review.omittedFileCount,
    ...(review.usage === undefined
      ? {}
      : { inputTokens: review.usage.inputTokens, outputTokens: review.usage.outputTokens }),
    durationMs: review.durationMs,
  };
}

interface ConfiguredEngine {
  readonly engine: ReviewEngine;
  /** Whether the repository allows its pull requests to be sent to an AI provider. */
  readonly isAiEnabled: boolean;
  /** Why the repository's configuration was not used; empty when it was, or when there is none. */
  readonly configurationIssues: readonly string[];
}

export function createReviewService(dependencies: ReviewServiceDependencies): ReviewService {
  const { clientFactory, logger, aiReviewer } = dependencies;
  const reviewStore = dependencies.reviewStore ?? createDiscardingReviewStore();
  const now = dependencies.now ?? ((): Date => new Date());
  const defaultEngine = createReviewEngine();

  /**
   * Builds an engine from the repository's configuration at the base commit. Reading it there,
   * and not at the head, stops a contributor from relaxing the checks on their own pull request.
   */
  async function loadEngine(client: RepositoryClient, baseSha: string): Promise<ConfiguredEngine> {
    // Defaults always mean no AI review: a broken file must never send code anywhere.
    const useDefaults = (...issues: string[]): ConfiguredEngine => ({
      engine: defaultEngine,
      isAiEnabled: false,
      configurationIssues: issues,
    });

    const lookup = await client.getFileText(CONFIGURATION_PATH, baseSha, MAX_CONFIGURATION_BYTES);
    if (lookup.status === "missing") {
      return useDefaults();
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

    const { ai, engineConfig } = splitConfiguration(config);
    const aiSettings = parseAiSettings(ai);
    const aiIssues = aiSettings.ok ? [] : aiSettings.issues;
    let engine: ReviewEngine;
    try {
      engine = createReviewEngine({ config: engineConfig });
    } catch (error) {
      if (error instanceof ConfigurationError) {
        return useDefaults(...error.issues, ...aiIssues);
      }
      throw error;
    }
    return aiSettings.ok
      ? { engine, isAiEnabled: aiSettings.settings.enabled, configurationIssues: [] }
      : useDefaults(...aiIssues);
  }

  /**
   * Asks the AI reviewer, if there is one and the repository allows it. Returns `undefined` when
   * no model was asked. Never rejects: suggestions are an extra, and the rules' findings are
   * published whatever happens here.
   */
  async function reviewWithAi(
    context: unknown,
    configured: ConfiguredEngine,
    logFields: LogFields,
  ): Promise<AiReview | undefined> {
    if (aiReviewer === undefined || !configured.isAiEnabled) {
      return undefined;
    }
    let review: AiReview;
    try {
      // The engine has accepted this context already; parsing it again yields the typed form.
      review = await aiReviewer.review(parseReviewContext(context), configured.engine.thresholds);
    } catch (error) {
      // Only the name: the message of an error from this path could quote the pull request.
      const { errorName } = describeError(error);
      logger.warn({ ...logFields, errorName }, "AI review could not run");
      return undefined;
    }
    if (review.status === "failed") {
      logger.warn(
        {
          ...logFields,
          failureReason: review.failureReason,
          ...(review.errorName === undefined ? {} : { errorName: review.errorName }),
        },
        "AI review failed",
      );
    }
    return review;
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
    const configured = await loadEngine(client, pullRequest.baseSha);
    const { engine, configurationIssues } = configured;
    const { context, skippedFileCount, omittedPatchCount } = toReviewContext(pullRequest, files);
    const result = await engine.review(context);
    const aiReview = await reviewWithAi(context, configured, logFields);
    // A review that sent nothing has nothing to show; one that failed is mentioned in the notes.
    const aiRecord =
      aiReviewer === undefined || aiReview === undefined
        ? undefined
        : toAiReviewRecord(aiReviewer, aiReview);
    const aiFindings = aiReview?.findings ?? [];

    // A push may have arrived while the review ran. Its own review is queued behind this one,
    // so this result is dropped instead of being published for a commit that is no longer the
    // head. This narrows the window but cannot close it: a push can still land between this
    // check and the comment call below. The review that push triggers then corrects the comment.
    const latest = await client.getPullRequest(pullRequestNumber);
    if (latest.headSha !== pullRequest.headSha || latest.state !== "open") {
      return skipped("stale", logFields);
    }

    const body = renderReviewSummary(
      // Thresholds hide suggestions as they hide findings, and one count covers both.
      {
        ...result,
        suppressedFindingCount:
          result.suppressedFindingCount + (aiReview?.suppressedFindingCount ?? 0),
      },
      {
        skippedFileCount,
        omittedPatchCount,
        unlistedFileCount: Math.max(0, pullRequest.changedFileCount - files.length),
        configurationIssues,
        configurationPath: CONFIGURATION_PATH,
        ...(aiRecord === undefined || aiRecord.status === "skipped"
          ? {}
          : {
              ai: {
                model: `${aiRecord.provider}/${aiRecord.model}`,
                isFailed: aiRecord.status === "failed",
                findings: aiFindings,
                omittedFileCount: aiRecord.omittedFileCount,
              },
            }),
      },
    );
    const comment = await publishReviewSummary(client, pullRequestNumber, body, {
      createIfMissing:
        result.findings.length > 0 || aiFindings.length > 0 || configurationIssues.length > 0,
    });

    // The summary above is the record of the review. Comments on lines are an extra: if they
    // cannot be posted, the review still stands and the reason is logged.
    let lineComments = { created: 0, deleted: 0 };
    try {
      lineComments = await publishInlineComments(
        client,
        pullRequestNumber,
        pullRequest.headSha,
        result.findings,
      );
    } catch (error) {
      logger.warn(
        { ...logFields, ...describeError(error) },
        "Line comments could not be published",
      );
    }

    logger.info(
      {
        ...logFields,
        headSha: pullRequest.headSha,
        findingCount: result.findings.length,
        suppressedFindingCount: result.suppressedFindingCount,
        lineCommentsCreated: lineComments.created,
        lineCommentsDeleted: lineComments.deleted,
        failedRuleCount: result.rules.filter((rule) => rule.status === "failed").length,
        skippedFileCount,
        omittedPatchCount,
        comment,
        ...(aiRecord === undefined
          ? {}
          : {
              aiStatus: aiRecord.status,
              aiFindingCount: aiRecord.findingCount,
              aiRejectedFindingCount: aiRecord.rejectedFindingCount,
              aiSentFileCount: aiRecord.sentFileCount,
              aiOmittedFileCount: aiRecord.omittedFileCount,
              aiDurationMs: aiRecord.durationMs,
              ...(aiRecord.inputTokens === undefined
                ? {}
                : {
                    aiInputTokens: aiRecord.inputTokens,
                    aiOutputTokens: aiRecord.outputTokens,
                  }),
            }),
      },
      "Review completed",
    );
    return {
      outcome: {
        status: "completed",
        headSha: pullRequest.headSha,
        findingCount: result.findings.length,
        ...(aiRecord === undefined ? {} : { aiFindingCount: aiRecord.findingCount }),
        comment,
      },
      recorded: {
        status: "completed",
        comment,
        skippedFileCount,
        omittedPatchCount,
        result,
        ...(aiRecord === undefined ? {} : { aiReview: aiRecord }),
      },
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
