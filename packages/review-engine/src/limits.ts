/**
 * Every size and time limit of the engine. Review input is written by people the engine does not
 * trust, so each value that reaches a loop, a regular expression or memory is bounded here.
 */

/** GitHub lists at most 3,000 files for one pull request. */
export const MAX_FILES = 3_000;
export const MAX_PATH_LENGTH = 1_024;
export const MAX_PATCH_LENGTH = 1_000_000;
/** All patches of one review together. Without it, 3,000 files could hold gigabytes. */
export const MAX_TOTAL_PATCH_LENGTH = 10_000_000;
export const MAX_TITLE_LENGTH = 1_024;
export const MAX_BODY_LENGTH = 262_144;

export const MAX_GLOB_PATTERNS = 100;
export const MAX_GLOB_LENGTH = 256;
/** Patterns one glob may expand to through brace alternatives such as `{js,ts}`. */
export const MAX_GLOB_EXPANSIONS = 64;

export const MAX_RULE_ID_LENGTH = 64;
export const MAX_RULE_DESCRIPTION_LENGTH = 500;

export const MAX_FINDINGS_PER_RULE = 100;
export const MAX_MESSAGE_LENGTH = 2_000;
export const MAX_SUGGESTION_LENGTH = 2_000;
export const MAX_EVIDENCE_ITEMS = 20;
export const MAX_EVIDENCE_LABEL_LENGTH = 100;
export const MAX_EVIDENCE_VALUE_LENGTH = 1_000;

export const DEFAULT_RULE_TIMEOUT_MS = 5_000;
export const MAX_RULE_TIMEOUT_MS = 60_000;
export const MAX_ERROR_MESSAGE_LENGTH = 500;
/** Validation issues can quote field names taken from untrusted input, so they are bounded. */
export const MAX_ISSUE_LENGTH = 300;
