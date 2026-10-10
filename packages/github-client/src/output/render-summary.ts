import { SEVERITIES, type ReviewFinding, type ReviewResult } from "@pr-buddy/review-engine";
import { escapeMarkdown, inlineCode } from "./markdown.js";

/** Hidden in every summary so PR Buddy can find its own comment again. */
export const SUMMARY_MARKER = "<!-- pr-buddy:summary -->";

/** GitHub rejects comments above 65,536 characters; findings stop being added before that. */
const MAX_FINDINGS_LENGTH = 55_000;
const SHORT_SHA_LENGTH = 7;
const PERCENT = 100;

/** Facts about the review that are not findings but that a reader should know. */
export interface SummaryNotes {
  /** Files left out because their paths could not be handled safely. */
  readonly skippedFileCount: number;
  /** Files beyond the number that can be listed for one pull request. */
  readonly unlistedFileCount: number;
  /** Files reviewed without their diff because it exceeded a size limit. */
  readonly omittedPatchCount: number;
  /** Problems in the repository's configuration file; defaults were used instead. */
  readonly configurationIssues: readonly string[];
  /** Path of the configuration file, for the message about `configurationIssues`. */
  readonly configurationPath: string;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function renderHeadline(result: ReviewResult): string {
  const commit = inlineCode(result.pullRequest.headSha.slice(0, SHORT_SHA_LENGTH));
  const { total, bySeverity } = result.summary;
  if (total === 0) {
    const ran = result.rules.filter((rule) => rule.status === "completed").length;
    return `**No findings** for commit ${commit}. ${capitalize(plural(ran, "check"))} ran.`;
  }
  const breakdown = [...SEVERITIES]
    .reverse()
    .filter((severity) => bySeverity[severity] > 0)
    .map((severity) => `${bySeverity[severity]} ${severity}`)
    .join(", ");
  return `**${plural(total, "finding")}** for commit ${commit}: ${breakdown}.`;
}

function renderFinding(finding: ReviewFinding): string {
  const lines = [
    `### ${capitalize(finding.severity)} · ${inlineCode(finding.ruleId)}`,
    "",
    escapeMarkdown(finding.message),
    "",
  ];
  if (finding.filePath !== undefined) {
    const line = finding.line === undefined ? "" : `, line ${finding.line}`;
    lines.push(`- **Location:** ${inlineCode(finding.filePath)}${line}`);
  }
  for (const evidence of finding.evidence) {
    lines.push(`- **${escapeMarkdown(evidence.label)}:** ${inlineCode(evidence.value)}`);
  }
  if (finding.suggestion !== undefined) {
    lines.push("", `**Suggested action:** ${escapeMarkdown(finding.suggestion)}`);
  }
  if (finding.confidence < 1) {
    const percent = Math.round(finding.confidence * PERCENT);
    lines.push("", `_Confidence ${percent}%: a signal to check, not a certainty._`);
  }
  return lines.join("\n");
}

function renderNotes(result: ReviewResult, notes: SummaryNotes): string[] {
  const lines: string[] = [];
  const failedRules = result.rules.filter((rule) => rule.status === "failed").length;
  if (failedRules > 0) {
    // Only the count is published: a rule's error text is for operators, not for the public.
    lines.push(`- ${capitalize(plural(failedRules, "check"))} could not run.`);
  }
  if (notes.skippedFileCount > 0) {
    lines.push(
      `- ${capitalize(plural(notes.skippedFileCount, "file"))} could not be reviewed because of an unusual path or format.`,
    );
  }
  if (notes.unlistedFileCount > 0) {
    lines.push(
      `- ${capitalize(plural(notes.unlistedFileCount, "file"))} beyond the first listed by GitHub ${notes.unlistedFileCount === 1 ? "was" : "were"} not reviewed.`,
    );
  }
  if (notes.omittedPatchCount > 0) {
    lines.push(
      `- The ${notes.omittedPatchCount === 1 ? "diff of 1 file was" : `diffs of ${notes.omittedPatchCount} files were`} too large to load, so only ${notes.omittedPatchCount === 1 ? "its name was" : "their names were"} checked.`,
    );
  }
  if (notes.configurationIssues.length > 0) {
    lines.push(
      `- The configuration in ${inlineCode(notes.configurationPath)} is invalid, so default settings were used:`,
      ...notes.configurationIssues.map((issue) => `  - ${inlineCode(issue)}`),
    );
  }
  return lines;
}

/**
 * Renders a review as the Markdown body of PR Buddy's summary comment. Text that a contributor
 * can influence, such as file names, is rendered so that it cannot create mentions, links or
 * HTML.
 */
export function renderReviewSummary(result: ReviewResult, notes: SummaryNotes): string {
  const sections = [SUMMARY_MARKER, "## PR Buddy review", renderHeadline(result)];

  let renderedLength = 0;
  let shown = 0;
  for (const finding of result.findings) {
    const rendered = renderFinding(finding);
    if (renderedLength + rendered.length > MAX_FINDINGS_LENGTH) {
      break;
    }
    sections.push(rendered);
    renderedLength += rendered.length;
    shown += 1;
  }
  const hidden = result.findings.length - shown;
  if (hidden > 0) {
    sections.push(
      `_${capitalize(plural(hidden, "more finding"))} not shown to keep this comment readable._`,
    );
  }

  const noteLines = renderNotes(result, notes);
  if (noteLines.length > 0) {
    sections.push(["#### Notes", "", ...noteLines].join("\n"));
  }

  sections.push(
    "---",
    "<sub>Deterministic checks only. PR Buddy does not approve, block or merge pull requests.</sub>",
  );
  return sections.join("\n\n");
}
