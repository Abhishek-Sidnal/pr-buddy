import type { FileChange, PullRequestSnapshot } from "@pr-buddy/github-client";
import { createPathMatcher } from "@pr-buddy/review-engine";
import { DOCUMENTATION_PATTERNS, MIN_REPUSH_CODE_LINES } from "./limits.js";

/**
 * Why a run stops before reviewing. Every gate is checked without asking a model anything.
 * - "closed", "draft": the pull request is not open for review.
 * - "same-commit": PR Buddy's comment already names this head commit.
 */
export type Gate = "closed" | "draft" | "same-commit";

/** The gate a pull request's state closes, if any. A merged pull request is closed. */
export function stateGate(pullRequest: PullRequestSnapshot): Gate | undefined {
  if (pullRequest.state !== "open") {
    return "closed";
  }
  return pullRequest.isDraft ? "draft" : undefined;
}

/** Whether the commit PR Buddy last reviewed is the one at the head now. */
export function sameCommitGate(
  reviewedCommit: string | undefined,
  headSha: string,
): Gate | undefined {
  return reviewedCommit === headSha ? "same-commit" : undefined;
}

const isDocumentation = createPathMatcher(DOCUMENTATION_PATTERNS);

/** Lines added and removed in files that are code, not documentation. */
export function countCodeLines(changes: readonly FileChange[]): number {
  return changes
    .filter((change) => !isDocumentation(change.path))
    .reduce((total, change) => total + change.additions + change.deletions, 0);
}

/**
 * How much a push changed since the last review, and what that means for cost.
 * - "first-review": nothing was reviewed before.
 * - "unknown": the two commits could not be compared, as after a force-push. Treated as large.
 * - "small": fewer code lines than the threshold. An AI review would be skipped.
 * - "large": enough changed to be worth a model's attention.
 */
export type RepushSize =
  | { readonly kind: "first-review" }
  | { readonly kind: "unknown" }
  | { readonly kind: "small"; readonly codeLines: number }
  | { readonly kind: "large"; readonly codeLines: number };

/**
 * Classifies a push. The rules run whatever the answer: they are free, and a comment that still
 * showed a finding the push removed would be wrong. The answer decides only whether a model is
 * worth asking, from the phase that adds one (D-109).
 */
export function classifyRepush(
  reviewedCommit: string | undefined,
  changes: readonly FileChange[] | undefined,
): RepushSize {
  if (reviewedCommit === undefined) {
    return { kind: "first-review" };
  }
  if (changes === undefined) {
    return { kind: "unknown" };
  }
  const codeLines = countCodeLines(changes);
  return codeLines < MIN_REPUSH_CODE_LINES
    ? { kind: "small", codeLines }
    : { kind: "large", codeLines };
}
