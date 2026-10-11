import { CONFIGURATION_PATH } from "@pr-buddy/ai-reviewer";
import { escapeMarkdown, inlineCode } from "@pr-buddy/github-client";
import type { ReviewFinding } from "@pr-buddy/review-engine";
import type { Gate, RepushSize } from "./gates.js";
import { MAX_JOB_SUMMARY_FINDINGS, MIN_REPUSH_CODE_LINES } from "./limits.js";
import type { CommentOutcome, RunOutcome } from "./run.js";

const HEADING = "## PR Buddy";
const SHORT_SHA_LENGTH = 7;

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

/** A finding as one table row. Paths and messages are text a contributor may have chosen. */
function renderFinding(finding: ReviewFinding): string {
  const location =
    finding.filePath === undefined
      ? "—"
      : cellCode(
          finding.line === undefined ? finding.filePath : `${finding.filePath}:${finding.line}`,
        );
  // `escapeMarkdown` escapes pipes too, so the message cannot end its cell either.
  return `| ${finding.severity} | ${cellCode(finding.ruleId)} | ${location} | ${escapeMarkdown(finding.message)} |`;
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
      lines.push("", "No AI model was asked. This version of the runner runs the rules only.");
      break;
    }
  }

  return `${lines.join("\n")}\n`;
}

/** What to say when a run failed. `reason` is fixed text; nothing from an error is quoted. */
export function renderFailureSummary(reason: string): string {
  return `${HEADING}\n\n**The run failed.** ${reason}\n\nNothing was published on the pull request by this run.\n`;
}
