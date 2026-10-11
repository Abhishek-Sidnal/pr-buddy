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

/*
 * The tools a model may use to read the checkout (docs/DESIGN-RUNNER.md, sections 8 and 13).
 * Lengths are in characters unless they say bytes.
 */

/** A longer path is not looked at. */
export const MAX_TOOL_PATH_LENGTH = 1_000;
/** A larger file is not read or searched: it is generated, a bundle or data. */
export const MAX_TOOL_FILE_BYTES = 1_024 * 1_024;
/** Lines one `read_file` call returns. */
export const MAX_READ_LINES = 400;
/** Characters kept from one line; a longer line, usually minified code, is cut. */
export const MAX_TOOL_LINE_LENGTH = 500;
/** What one tool call may return. */
export const MAX_TOOL_RESPONSE_LENGTH = 40_000;
/** What all tool calls of one review may return together. Reaching it stops the review. */
export const MAX_TOTAL_TOOL_OUTPUT_LENGTH = 400_000;

/** A shorter text matches too much to be useful. */
export const MIN_SEARCH_QUERY_LENGTH = 3;
export const MAX_SEARCH_QUERY_LENGTH = 200;
/** Matching lines one `search` call returns. */
export const MAX_SEARCH_MATCHES = 50;
/** Files one `search` call reads. */
export const MAX_SEARCH_FILES = 5_000;
/** Bytes one `search` call reads, over all files. */
export const MAX_SEARCH_BYTES = 64 * 1_024 * 1_024;
/** Folder entries one `search` call looks at, read or not. */
export const MAX_SEARCH_ENTRIES = 50_000;

/** Entries one `list_files` call returns. */
export const MAX_LIST_ENTRIES = 200;

/** `.git/HEAD` holds one commit ID or one reference; anything longer is not that file. */
export const MAX_HEAD_FILE_BYTES = 200;
