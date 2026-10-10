import { createHash } from "node:crypto";
import type { ReviewFinding } from "@pr-buddy/review-engine";
import type { NewLineComment, RepositoryClient, ReviewComment } from "../api/repository-client.js";
import { escapeMarkdown, inlineCode } from "./markdown.js";

/** Most line comments one review may leave. The summary comment always lists every finding. */
export const MAX_INLINE_COMMENTS = 20;

const FINGERPRINT_LENGTH = 16;
const FINGERPRINT_MARKER = /<!-- pr-buddy:finding:([0-9a-f]{16}) -->/;
const PERCENT = 100;

type LocatedFinding = ReviewFinding & { readonly filePath: string; readonly line: number };

function isLocated(finding: ReviewFinding): finding is LocatedFinding {
  return finding.filePath !== undefined && finding.line !== undefined;
}

/**
 * Identifies a finding at a place: the same rule saying the same thing about the same line.
 * It is what lets a later review recognise a comment it has already left.
 */
export function fingerprintOf(finding: LocatedFinding): string {
  return createHash("sha256")
    .update(JSON.stringify([finding.ruleId, finding.filePath, finding.line, finding.message]))
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Renders one finding as the body of a comment on its line. */
export function renderInlineComment(finding: LocatedFinding): string {
  const parts = [
    `**${capitalize(finding.severity)}** · ${inlineCode(finding.ruleId)}`,
    escapeMarkdown(finding.message),
  ];
  if (finding.suggestion !== undefined) {
    parts.push(`**Suggested action:** ${escapeMarkdown(finding.suggestion)}`);
  }
  if (finding.confidence < 1) {
    const percent = Math.round(finding.confidence * PERCENT);
    parts.push(`_Confidence ${percent}%: a signal to check, not a certainty._`);
  }
  parts.push(`<!-- pr-buddy:finding:${fingerprintOf(finding)} -->`);
  return parts.join("\n\n");
}

export interface InlineCommentPlan {
  readonly toCreate: readonly NewLineComment[];
  /** IDs of PR Buddy's comments whose finding is gone, or that repeat another comment. */
  readonly toDelete: readonly number[];
}

/**
 * Decides which line comments to post and which to remove, given the comments PR Buddy has
 * already left. A finding that already has its comment is left alone, so reviewing again never
 * repeats a comment. Comments without PR Buddy's marker are never touched.
 */
export function planInlineComments(
  findings: readonly ReviewFinding[],
  existing: readonly ReviewComment[],
  limit: number = MAX_INLINE_COMMENTS,
): InlineCommentPlan {
  const wanted = new Map<string, LocatedFinding>();
  for (const finding of findings.filter(isLocated).slice(0, limit)) {
    wanted.set(fingerprintOf(finding), finding);
  }

  const present = new Set<string>();
  const toDelete: number[] = [];
  for (const comment of existing) {
    const fingerprint = FINGERPRINT_MARKER.exec(comment.body)?.[1];
    if (fingerprint === undefined) {
      continue;
    }
    if (wanted.has(fingerprint) && !present.has(fingerprint)) {
      present.add(fingerprint);
    } else {
      toDelete.push(comment.id);
    }
  }

  const toCreate = [...wanted]
    .filter(([fingerprint]) => !present.has(fingerprint))
    .map(([, finding]) => ({
      path: finding.filePath,
      line: finding.line,
      body: renderInlineComment(finding),
    }));
  return { toCreate, toDelete };
}

export interface InlinePublishResult {
  readonly created: number;
  readonly deleted: number;
}

/**
 * Brings PR Buddy's line comments on a pull request in step with the findings of a review:
 * removes the ones that no longer apply, then posts the new ones as a single review.
 */
export async function publishInlineComments(
  client: RepositoryClient,
  pullRequestNumber: number,
  headSha: string,
  findings: readonly ReviewFinding[],
): Promise<InlinePublishResult> {
  const existing = await client.listOwnReviewComments(pullRequestNumber);
  const plan = planInlineComments(findings, existing);

  for (const commentId of plan.toDelete) {
    await client.deleteReviewComment(commentId);
  }
  if (plan.toCreate.length > 0) {
    await client.createReviewWithComments(pullRequestNumber, headSha, plan.toCreate);
  }
  return { created: plan.toCreate.length, deleted: plan.toDelete.length };
}
