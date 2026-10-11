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
import {
  CONFIGURATION_PATH,
  MAX_CONFIGURATION_BYTES,
  parseRepositoryConfiguration,
  type AiReview,
  type AiReviewer,
  type RepositoryConfiguration,
} from "@pr-buddy/ai-reviewer";
import { createReviewEngine, parseReviewContext } from "@pr-buddy/review-engine";
import { describeError, type LogFields, type Logger } from "../../logger.js";
import {
  createDiscardingReviewStore,
  type AiReviewRecord,
  type RecordedOutcome,
  type ReviewStore,
  type SkipReason,
} from "./review-store.js";

/** Where a repository keeps its PR Buddy settings. The app may read this file and no other. */
export { CONFIGURATION_PATH };

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
  /**
   * The reviewer for an installation that has stored a provider and key of its own, or
   * `undefined` if it has none. It may reject when the stored key cannot be used; the operator's
   * reviewer is then not tried.
   */
  readonly resolveInstallationReviewer?: (
    installationId: number,
  ) => Promise<AiReviewer | undefined>;
  /** Replaceable so tests control time. */
  readonly now?: () => Date;
}

/** Reduces an AI review to what is kept: identifiers, counts and timings, never its text. */
/** Which provider and model a review was asked of. */
type ReviewerIdentity = Pick<AiReviewer, "provider" | "model">;

/** Stands for the provider in the record of a review whose installation key could not be used. */
const UNUSABLE_INSTALLATION_KEY: ReviewerIdentity = {
  provider: "installation-key",
  model: "unavailable",
};

function toAiReviewRecord(reviewer: ReviewerIdentity, review: AiReview): AiReviewRecord {
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

/** The repository's configuration, as the hosted service and the Action both read it. */
type ConfiguredEngine = RepositoryConfiguration;

export function createReviewService(dependencies: ReviewServiceDependencies): ReviewService {
  const { clientFactory, logger, aiReviewer, resolveInstallationReviewer } = dependencies;
  const reviewStore = dependencies.reviewStore ?? createDiscardingReviewStore();
  const now = dependencies.now ?? ((): Date => new Date());
  const defaultEngine = createReviewEngine();

  /**
   * Reads the repository's configuration at the base commit. Reading it there, and not at the
   * head, stops a contributor from relaxing the checks, or switching who reviews, on their own
   * pull request.
   */
  async function loadEngine(client: RepositoryClient, baseSha: string): Promise<ConfiguredEngine> {
    return parseRepositoryConfiguration(
      await client.getFileText(CONFIGURATION_PATH, baseSha, MAX_CONFIGURATION_BYTES),
      defaultEngine,
    );
  }

  /**
   * Asks the AI reviewer, if there is one and the repository allows it. Returns `undefined` when
   * no model was asked. Never rejects: suggestions are an extra, and the rules' findings are
   * published whatever happens here.
   */
  async function reviewWithAi(
    context: unknown,
    configured: ConfiguredEngine,
    installationId: number,
    logFields: LogFields,
  ): Promise<{ reviewer: ReviewerIdentity; review: AiReview } | undefined> {
    if (!configured.isAiEnabled) {
      return undefined;
    }

    // An installation's own provider wins over the operator's. If its key cannot be used, the
    // AI review fails: falling back would send the code to a company the customer did not
    // choose (D-078).
    let reviewer: AiReviewer | undefined;
    try {
      reviewer = (await resolveInstallationReviewer?.(installationId)) ?? aiReviewer;
    } catch (error) {
      const { errorName } = describeError(error);
      logger.warn({ ...logFields, errorName }, "The installation's AI key could not be used");
      return {
        reviewer: UNUSABLE_INSTALLATION_KEY,
        review: {
          status: "failed",
          failureReason: "provider-error",
          errorName: "InstallationKeyUnusable",
          findings: [],
          suppressedFindingCount: 0,
          rejectedFindingCount: 0,
          sentFileCount: 0,
          omittedFileCount: 0,
          durationMs: 0,
        },
      };
    }
    if (reviewer === undefined) {
      return undefined;
    }

    let review: AiReview;
    try {
      // The engine has accepted this context already; parsing it again yields the typed form.
      review = await reviewer.review(parseReviewContext(context), configured.engine.thresholds);
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
    return { reviewer, review };
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

    const configured = await loadEngine(client, pullRequest.baseSha);
    if (configured.mode === "runner") {
      // The repository reviews itself, with a GitHub Action in its own CI. Reviewing here as
      // well would put two reviews on one pull request (D-105).
      return skipped("runner", logFields);
    }

    const files = await client.listPullRequestFiles(pullRequestNumber, REVIEW_FILE_LIMITS);
    const { engine, issues: configurationIssues } = configured;
    const { context, skippedFileCount, omittedPatchCount } = toReviewContext(pullRequest, files);
    const result = await engine.review(context);
    const ai = await reviewWithAi(context, configured, trigger.installationId, logFields);
    const aiReview = ai?.review;
    // A review that sent nothing has nothing to show; one that failed is mentioned in the notes.
    const aiRecord = ai === undefined ? undefined : toAiReviewRecord(ai.reviewer, ai.review);
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
