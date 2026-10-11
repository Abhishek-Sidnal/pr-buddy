import { CONFIGURATION_PATH, type ToolLoopStop } from "@pr-buddy/ai-reviewer";
import { escapeMarkdown, inlineCode } from "@pr-buddy/github-client";
import type { ReviewFinding } from "@pr-buddy/review-engine";
import type { AiOutcome, AiSkipReason } from "./ai-step.js";
import type { Gate, RepushSize } from "./gates.js";
import { MAX_JOB_SUMMARY_FINDINGS, MIN_REPUSH_CODE_LINES } from "./limits.js";
import type { CommentOutcome, RunOutcome } from "./run.js";

const HEADING = "## PR Buddy";
const SHORT_SHA_LENGTH = 7;
const MS_PER_SECOND = 1_000;

const GATES: Readonly<Record<Gate, string>> = {
  closed: "The pull request is closed or merged, so it was not reviewed.",
  draft: "The pull request is a draft. It is reviewed when it is marked ready for review.",
  "same-commit":
    "This commit was already reviewed: PR Buddy's comment on the pull request names it. Nothing was done.",
};

const COMMENTS: Readonly<Record<CommentOutcome, string>> = {
  created: "A summary comment was posted on the pull request.",
  updated: "The summary comment on the pull request was updated.",
  none: "No comment was posted: there are no findings and there was no earlier comment to correct.",
  "not-permitted":
    "No comment was posted: this pull request comes from a fork, and GitHub gives such a run a token that cannot write. The findings are below.",
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const AI_SKIPS: Readonly<Record<AiSkipReason, string>> = {
  "not-enabled": `No AI model was asked: ${inlineCode(CONFIGURATION_PATH)} on the base branch does not turn AI review on (${inlineCode('"ai": { "enabled": true }')}).`,
  "no-provider":
    "No AI model was asked: the workflow gave no AI provider. A pull request from a fork never has one, because GitHub gives it no secrets.",
  "invalid-provider":
    "No AI model was asked: the workflow's inputs for the AI provider are not valid.",
  "too-large":
    "No AI model was asked: the pull request is too large to load completely, so a model would see only part of it.",
  "small-repush": `No AI model was asked: fewer than ${MIN_REPUSH_CODE_LINES} code lines changed since the last review.`,
  "no-checkout":
    "No AI model was asked: there is no checkout of the repository. Add a checkout step before PR Buddy.",
  "wrong-checkout":
    "No AI model was asked: the checkout is not at the pull request's head commit. Give the checkout step `ref: ${{ github.event.pull_request.head.sha }}`.",
};

const AI_STOPS: Readonly<Record<ToolLoopStop, string | undefined>> = {
  answered: undefined,
  steps: "It reached the limit on steps and was asked for its answer.",
  tokens: "It reached the limit on tokens and was asked for its answer.",
  caller: "It reached the limit on how much may be read and was asked for its answer.",
};

/** What came of the AI review. Counts and fixed words only: nothing a model wrote. */
function describeAi(ai: AiOutcome): string[] {
  if (ai.kind === "skipped") {
    const fields =
      ai.fields === undefined || ai.fields.length === 0
        ? ""
        : ` Check: ${ai.fields.map((field) => inlineCode(field)).join(", ")}.`;
    return [`${AI_SKIPS[ai.reason]}${fields}`];
  }
  const { review } = ai;
  const model = inlineCode(ai.model);
  if (review.status === "skipped") {
    return [`No AI model was asked: no changed file could be sent to ${model}.`];
  }
  const tokens =
    review.usage === undefined
      ? "The provider reported no token counts."
      : `${review.usage.inputTokens.toLocaleString("en-US")} input and ${review.usage.outputTokens.toLocaleString("en-US")} output tokens.`;
  const effort = `${plural(review.requestCount, "request")}, ${plural(review.toolCallCount, "tool call")}, ${plural(ai.readLineCount, "line")} of ${plural(ai.readFileCount, "file")} given to it, ${Math.round(review.durationMs / MS_PER_SECOND)} s. ${tokens}`;
  if (review.status === "failed") {
    const why =
      review.failureReason === "timeout"
        ? "it ran out of time"
        : review.failureReason === "invalid-response"
          ? "its reply could not be used"
          : `the provider failed (${inlineCode(review.errorName ?? "Error")})`;
    return [
      `**The AI review by ${model} could not be completed:** ${why}. The rules' result stands.`,
      effort,
    ];
  }
  const stop = review.stop === undefined ? undefined : AI_STOPS[review.stop];
  const dropped =
    review.rejectedFindingCount > 0
      ? ` ${plural(review.rejectedFindingCount, "suggestion")} dropped: malformed, repeated, or about a line it was not given.`
      : "";
  return [
    `AI review by ${model}: **${plural(review.findings.length, "suggestion")}**.${dropped}${stop === undefined ? "" : ` ${stop}`}`,
    effort,
  ];
}
function describeRepush(repush: RepushSize): string | undefined {
  switch (repush.kind) {
    case "first-review":
      return undefined;
    case "unknown":
      return "How much changed since the last review could not be measured, as after a force-push.";
    case "small":
      return `${plural(repush.codeLines, "code line")} changed since the last review, fewer than ${MIN_REPUSH_CODE_LINES}. The rules ran again, because they cost nothing.`;
    case "large":
      return `${plural(repush.codeLines, "code line")} changed since the last review.`;
  }
}

/** Inline code for a table cell. A pipe ends a cell even inside code, unless it is escaped. */
function cellCode(text: string): string {
  return inlineCode(text).replaceAll("|", "\\|");
}

/** Where a finding is, as a table cell. A path is text a contributor may have chosen. */
function renderLocation(finding: ReviewFinding): string {
  return finding.filePath === undefined
    ? "—"
    : cellCode(
        finding.line === undefined ? finding.filePath : `${finding.filePath}:${finding.line}`,
      );
}

/** A finding as one table row. Paths and messages are text a contributor may have chosen. */
function renderFinding(finding: ReviewFinding): string {
  // `escapeMarkdown` escapes pipes too, so the message cannot end its cell either.
  return `| ${finding.severity} | ${cellCode(finding.ruleId)} | ${renderLocation(finding)} | ${escapeMarkdown(finding.message)} |`;
}

/**
 * What a run did, for the job's summary page. It is the only output when no comment could be
 * written, so it carries the findings as well.
 */
export function renderJobSummary(outcome: RunOutcome): string {
  const lines = [HEADING, ""];

  switch (outcome.kind) {
    case "not-runner":
      lines.push(
        `Nothing was done. The configuration at the pull request's base commit does not select runner mode, so this repository is reviewed by the hosted service, if at all.`,
        "",
        `To review here, ${inlineCode(CONFIGURATION_PATH)} on the base branch must contain ${inlineCode('"review": { "mode": "runner" }')}.`,
      );
      if (outcome.issues.length > 0) {
        lines.push(
          "",
          "That file was not used, because it is invalid:",
          "",
          ...outcome.issues.map((issue) => `- ${escapeMarkdown(issue)}`),
        );
      }
      break;

    case "gated":
      lines.push(GATES[outcome.gate]);
      break;

    case "superseded":
      lines.push(
        "A newer commit arrived while this review ran, so its result was not published. That commit has its own run.",
      );
      break;

    case "reviewed": {
      const { result } = outcome;
      const commit = inlineCode(result.pullRequest.headSha.slice(0, SHORT_SHA_LENGTH));
      const ran = result.rules.filter((rule) => rule.status === "completed").length;
      const failed = result.rules.filter((rule) => rule.status === "failed").length;
      lines.push(
        `Reviewed commit ${commit} with ${plural(ran, "rule")}: **${plural(result.findings.length, "finding")}**.`,
        "",
        COMMENTS[outcome.comment],
      );
      const repush = describeRepush(outcome.repush);
      if (repush !== undefined) {
        lines.push("", repush);
      }
      const notes = [
        failed > 0 ? `${plural(failed, "rule")} failed and reported nothing.` : undefined,
        result.suppressedFindingCount > 0
          ? `${plural(result.suppressedFindingCount, "finding")} fell below the repository's reporting thresholds.`
          : undefined,
        outcome.unlistedFileCount > 0
          ? `${plural(outcome.unlistedFileCount, "file")} beyond the limit were not looked at.`
          : undefined,
        outcome.omittedPatchCount > 0
          ? `${plural(outcome.omittedPatchCount, "file")} had a diff too large to read.`
          : undefined,
        outcome.skippedFileCount > 0
          ? `${plural(outcome.skippedFileCount, "file")} had a path that could not be handled safely.`
          : undefined,
      ].filter((note) => note !== undefined);
      if (notes.length > 0) {
        lines.push("", ...notes.map((note) => `- ${note}`));
      }
      if (result.findings.length > 0) {
        const shown = result.findings.slice(0, MAX_JOB_SUMMARY_FINDINGS);
        lines.push(
          "",
          "| Severity | Rule | Where | Finding |",
          "| --- | --- | --- | --- |",
          ...shown.map(renderFinding),
        );
        if (shown.length < result.findings.length) {
          lines.push("", `${plural(result.findings.length - shown.length, "more finding")}.`);
        }
      }
      for (const line of describeAi(outcome.ai)) {
        lines.push("", line);
      }
      if (outcome.ai.kind === "asked" && outcome.ai.review.findings.length > 0) {
        lines.push(
          "",
          "| Severity | Where | AI suggestion |",
          "| --- | --- | --- |",
          ...outcome.ai.review.findings.map(
            (finding) =>
              `| ${finding.severity} | ${renderLocation(finding)} | ${escapeMarkdown(finding.message)} |`,
          ),
        );
      }
      break;
    }
  }

  return `${lines.join("\n")}\n`;
}

/** What to say when a run failed. `reason` is fixed text; nothing from an error is quoted. */
export function renderFailureSummary(reason: string): string {
  return `${HEADING}\n\n**The run failed.** ${reason}\n\nNothing was published on the pull request by this run.\n`;
}
