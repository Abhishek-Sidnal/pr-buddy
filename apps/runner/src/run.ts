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
import type { ReviewResult } from "@pr-buddy/review-engine";
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
  });
  // The marker goes last, after anything a pull request could have put into the text above.
  const body = `${summary}\n\n${renderReviewedMarker(pullRequest.headSha)}\n`;

  let comment: CommentOutcome;
  try {
    comment = await publishReviewSummary(client, pullRequestNumber, body, {
      // A clean pull request stays quiet; an existing comment is still corrected.
      createIfMissing: result.findings.length > 0,
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
    isFromFork: pullRequest.isFromFork,
    skippedFileCount,
    omittedPatchCount,
    unlistedFileCount,
  };
}
