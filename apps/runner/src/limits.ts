/**
 * Fewer changed code lines than this, since the commit PR Buddy last reviewed, is a small
 * re-push. The rules still run on it, because they cost nothing; an AI review would not.
 */
export const MIN_REPUSH_CODE_LINES = 50;

/**
 * Files that are not code, for counting how much code a push changed. Matched with PR Buddy's
 * own glob matcher.
 */
export const DOCUMENTATION_PATTERNS = [
  "**/*.md",
  "**/*.mdx",
  "**/*.txt",
  "**/*.rst",
  "**/*.adoc",
  "docs/**",
  "LICENSE",
  "LICENSE.*",
] as const;

/** A longer event file is not read: the runner takes one number from it. */
export const MAX_EVENT_BYTES = 5 * 1_024 * 1_024;

/** Findings listed in the job summary. The comment on the pull request has its own limit. */
export const MAX_JOB_SUMMARY_FINDINGS = 50;
