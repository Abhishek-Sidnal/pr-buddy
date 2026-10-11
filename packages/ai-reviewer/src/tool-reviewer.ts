import {
  compareSeverity,
  type ReportThresholds,
  type ReviewContext,
  type ReviewFinding,
} from "@pr-buddy/review-engine";
import type { AiReview } from "./ai-reviewer.js";
import { parseResponse } from "./output/parse-response.js";
import { toReadFindings, type ReadEvidence } from "./output/to-findings.js";
import { buildToolPrompt } from "./prompt/build-tool-prompt.js";
import { selectFiles } from "./prompt/select-files.js";
import type { AiToolProvider } from "./provider.js";
import { runToolLoop, type ToolLoopLimits, type ToolLoopStop } from "./tool-loop.js";
import type { AiTool } from "./tool.js";

/** What came of a review in which the model could read more than the diff. */
export interface ToolReview extends AiReview {
  /** Requests made to the model. */
  readonly requestCount: number;
  /** Tool requests served, refused ones included. */
  readonly toolCallCount: number;
  /** Present when completed. Anything but "answered" means a limit ended the search early. */
  readonly stop?: ToolLoopStop;
}

export interface ToolReviewOptions {
  readonly provider: AiToolProvider;
  /** A pull request that the engine has already validated. */
  readonly context: ReviewContext;
  readonly tools: readonly AiTool[];
  /**
   * The record of what the model is given. The lines of the diff are added to it here; the
   * tools must add what they return. A finding outside it is dropped.
   */
  readonly evidence: ReadEvidence;
  readonly thresholds?: ReportThresholds;
  /** The rules' findings. A suggestion at the same file and line as one of them is dropped. */
  readonly ruleFindings?: readonly ReviewFinding[];
  readonly limits?: Partial<ToolLoopLimits>;
  /** True ends the search; see `ToolLoopOptions.shouldStop`. */
  readonly shouldStop?: () => boolean;
  /** Replaceable so tests control time. Returns milliseconds. */
  readonly now?: () => number;
}

function meetsThresholds(finding: ReviewFinding, thresholds: ReportThresholds): boolean {
  return (
    compareSeverity(finding.severity, thresholds.minSeverity) >= 0 &&
    finding.confidence >= thresholds.minConfidence
  );
}

function repeatsARule(finding: ReviewFinding, ruleFindings: readonly ReviewFinding[]): boolean {
  return (
    finding.filePath !== undefined &&
    finding.line !== undefined &&
    ruleFindings.some((other) => other.filePath === finding.filePath && other.line === finding.line)
  );
}

/**
 * Asks a model about a pull request and lets it read more through the tools it is given, within
 * the loop's limits. Used in runner mode only: the hosted reviewer offers no tools.
 *
 * As with `createAiReviewer`, the model never sets a rule ID, a confidence or evidence, cannot
 * report `critical`, and never rejects because of the provider or its reply.
 */
export async function reviewWithTools(options: ToolReviewOptions): Promise<ToolReview> {
  const { provider, context, evidence, thresholds } = options;
  const { selected, omittedFileCount } = selectFiles(context.files);
  const base = {
    findings: [],
    suppressedFindingCount: 0,
    rejectedFindingCount: 0,
    sentFileCount: selected.length,
    omittedFileCount,
  };
  if (selected.length === 0) {
    return { ...base, status: "skipped", durationMs: 0, requestCount: 0, toolCallCount: 0 };
  }

  // The diff is given to the model in the first message, so its lines count as read.
  for (const { file, lines } of selected) {
    for (const { line } of lines) {
      evidence.addLine(file.path, line);
    }
  }

  const loop = await runToolLoop({
    provider,
    ...buildToolPrompt(context.pullRequest, selected),
    tools: options.tools,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.shouldStop === undefined ? {} : { shouldStop: options.shouldStop }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const counts = {
    ...base,
    ...(loop.usage === undefined ? {} : { usage: loop.usage }),
    durationMs: loop.durationMs,
    requestCount: loop.requestCount,
    toolCallCount: loop.toolCallCount,
  };
  if (loop.status === "failed") {
    return {
      ...counts,
      status: "failed",
      failureReason: loop.failureReason,
      ...(loop.errorName === undefined ? {} : { errorName: loop.errorName }),
    };
  }

  const reply = parseResponse(loop.text);
  if (reply === undefined) {
    return { ...counts, status: "failed", failureReason: "invalid-response" };
  }
  const verified = toReadFindings(reply.suggestions, evidence);
  const distinct = verified.findings.filter(
    (finding) => !repeatsARule(finding, options.ruleFindings ?? []),
  );
  const findings =
    thresholds === undefined
      ? distinct
      : distinct.filter((finding) => meetsThresholds(finding, thresholds));
  return {
    ...counts,
    status: "completed",
    stop: loop.stop,
    findings,
    suppressedFindingCount: distinct.length - findings.length,
    // Malformed, unread, repeated among themselves, or repeating a rule's finding.
    rejectedFindingCount:
      reply.rejectedCount + verified.rejectedCount + (verified.findings.length - distinct.length),
  };
}
