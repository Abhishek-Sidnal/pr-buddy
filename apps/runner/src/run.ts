import {
  CONFIGURATION_PATH,
  MAX_CONFIGURATION_BYTES,
  parseRepositoryConfiguration,
  type ConfigurationLookup,
} from "@pr-buddy/ai-reviewer";
import {
  publishReviewSummary,
  renderReviewSummary,
  REVIEW_FILE_LIMITS,
  SUMMARY_MARKER,
  toReviewContext,
  type PublishAction,
  type RepositoryClient,
} from "@pr-buddy/github-client";
import { parseReviewContext, type ReviewResult } from "@pr-buddy/review-engine";
import { runAiStep, type AiDependencies, type AiOutcome, type AiSkipReason } from "./ai-step.js";
import { classifyRepush, sameCommitGate, stateGate, type Gate, type RepushSize } from "./gates.js";
import { readReviewedCommit, renderReviewedMarker } from "./markers.js";

/**
 * Thrown when the runner cannot tell which mode the repository is in. Nothing is reviewed and
 * nothing is published: acting on a guess could put two reviewers on one pull request (D-105).
 */
export class ModeUnknownError extends Error {
  constructor() {
    super("The review mode could not be established from the base commit.");
    this.name = "ModeUnknownError";
  }
}

/** What became of the summary comment. */
export type CommentOutcome =
  | PublishAction
  /** GitHub refused the write, as it does for a pull request from a fork. */
  | "not-permitted";

/** What one run did. Everything the job summary says comes from here. */
export type RunOutcome =
  /** The base commit does not select runner mode; `issues` says why its file was not used. */
  | { readonly kind: "not-runner"; readonly issues: readonly string[] }
  | { readonly kind: "gated"; readonly gate: Gate }
  /** A newer commit arrived while the review ran; its own run reviews it. */
  | { readonly kind: "superseded" }
  | {
      readonly kind: "reviewed";
      readonly result: ReviewResult;
      readonly comment: CommentOutcome;
      readonly repush: RepushSize;
      /** What came of the AI review, or why no model was asked. */
      readonly ai: AiOutcome;
      readonly isFromFork: boolean;
      /** Files left out because their paths could not be handled safely. */
      readonly skippedFileCount: number;
      /** Files reviewed without their diff because it exceeded a size limit. */
      readonly omittedPatchCount: number;
      /** Files beyond the number that can be listed for one pull request. */
      readonly unlistedFileCount: number;
    };

export interface RunDependencies {
  /** Acts with the workflow's own token. */
  readonly client: RepositoryClient;
  /** Taken from the event. It is only a pointer: what is reviewed is fetched from GitHub. */
  readonly pullRequestNumber: number;
  /** The provider the workflow configured, and its checkout. Absent means rules only. */
  readonly ai?: AiDependencies;
}

/**
 * What a reader of the comment should know when AI review is on for the repository and no
 * model was asked about this push. Fixed text. Reasons that mean "this repository does not use
 * AI review here" say nothing: the job summary has them.
 */
const AI_COMMENT_NOTES: Readonly<Partial<Record<AiSkipReason, string>>> = {
  "small-repush":
    "The AI review did not run for this push, because it changed little since the last review. Suggestions from an earlier review are not repeated here.",
  "too-large":
    "The AI review did not run, because this pull request is too large to load completely.",
  "no-checkout":
    "The AI review did not run, because the workflow does not check the repository out.",
  "wrong-checkout":
    "The AI review did not run, because the workflow's checkout is not at this pull request's latest commit.",
  "invalid-provider":
    "The AI review did not run, because the workflow's settings for the AI provider are not valid.",
};

function aiCommentNotes(ai: AiOutcome): readonly string[] {
  const note = ai.kind === "skipped" ? AI_COMMENT_NOTES[ai.reason] : undefined;
  return note === undefined ? [] : [note];
}

const FORBIDDEN = 403;

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" && error !== null && "status" in error && error.status === status
  );
}

/**
 * Reviews one pull request with PR Buddy's deterministic rules, inside the repository's own CI,
 * and publishes the result as one summary comment. No model is asked and nothing from the pull
 * request is executed. See docs/DESIGN-RUNNER.md.
 *
 * @throws {ModeUnknownError} if the configuration at the base commit cannot be read.
 */
export async function runReview(dependencies: RunDependencies): Promise<RunOutcome> {
  const { client, pullRequestNumber } = dependencies;

  const pullRequest = await client.getPullRequest(pullRequestNumber);

  // The mode comes from the base commit, never from the pull request's own copy of the file, so
  // a pull request cannot decide who reviews it. Without it nothing else is done.
  let lookup: ConfigurationLookup;
  try {
    lookup = await client.getFileText(
      CONFIGURATION_PATH,
      pullRequest.baseSha,
      MAX_CONFIGURATION_BYTES,
    );
  } catch {
    throw new ModeUnknownError();
  }
  const configuration = parseRepositoryConfiguration(lookup);
  if (configuration.mode !== "runner") {
    return { kind: "not-runner", issues: configuration.issues };
  }

  const closedGate = stateGate(pullRequest);
  if (closedGate !== undefined) {
    return { kind: "gated", gate: closedGate };
  }

  const ownComment = await client.getOwnComment(pullRequestNumber, SUMMARY_MARKER);
  const reviewedCommit = readReviewedCommit(ownComment?.body);
  const repeatGate = sameCommitGate(reviewedCommit, pullRequest.headSha);
  if (repeatGate !== undefined) {
    return { kind: "gated", gate: repeatGate };
  }

  const repush = classifyRepush(
    reviewedCommit,
    reviewedCommit === undefined
      ? undefined
      : await client.compareCommits(reviewedCommit, pullRequest.headSha),
  );

  const files = await client.listPullRequestFiles(pullRequestNumber, REVIEW_FILE_LIMITS);
  const { context, skippedFileCount, omittedPatchCount } = toReviewContext(pullRequest, files);
  const result = await configuration.engine.review(context);
  const unlistedFileCount = Math.max(0, pullRequest.changedFileCount - files.length);

  // The rules have run and stand whatever happens next. A model is asked only if every gate
  // on cost allows it, and its failure is a note in the comment, never a failed review.
  const ai = await runAiStep({
    ai: dependencies.ai,
    isAiEnabled: configuration.isAiEnabled,
    headSha: pullRequest.headSha,
    context: parseReviewContext(context),
    ruleFindings: result.findings,
    thresholds: configuration.engine.thresholds,
    repush,
    isIncomplete: unlistedFileCount > 0 || omittedPatchCount > 0,
  });

  // A push may have arrived while the rules ran. Its own run reviews it; publishing this result
  // would put findings for an old commit under the new one.
  const latest = await client.getPullRequest(pullRequestNumber);
  if (latest.headSha !== pullRequest.headSha || latest.state !== "open") {
    return { kind: "superseded" };
  }

  const summary = renderReviewSummary(result, {
    skippedFileCount,
    omittedPatchCount,
    unlistedFileCount,
    configurationIssues: configuration.issues,
    configurationPath: CONFIGURATION_PATH,
    ...(ai.kind === "asked"
      ? {
          ai: {
            model: ai.model,
            isFailed: ai.review.status === "failed",
            findings: ai.review.findings,
            omittedFileCount: ai.review.omittedFileCount,
            source: "checkout" as const,
            isStoppedEarly: ai.review.stop !== undefined && ai.review.stop !== "answered",
          },
        }
      : {}),
    extraNotes: aiCommentNotes(ai),
  });
  // The marker goes last, after anything a pull request could have put into the text above.
  const body = `${summary}\n\n${renderReviewedMarker(pullRequest.headSha)}\n`;

  let comment: CommentOutcome;
  try {
    comment = await publishReviewSummary(client, pullRequestNumber, body, {
      // A clean pull request stays quiet; an existing comment is still corrected.
      createIfMissing:
        result.findings.length > 0 || (ai.kind === "asked" && ai.review.findings.length > 0),
    });
  } catch (error) {
    // GitHub gives a fork's pull request a token that cannot write. That is by design, and
    // nothing is loosened to get around it: the result goes to the job summary alone.
    if (pullRequest.isFromFork && hasStatus(error, FORBIDDEN)) {
      comment = "not-permitted";
    } else {
      throw error;
    }
  }

  return {
    kind: "reviewed",
    result,
    comment,
    repush,
    ai,
    isFromFork: pullRequest.isFromFork,
    skippedFileCount,
    omittedPatchCount,
    unlistedFileCount,
  };
}
