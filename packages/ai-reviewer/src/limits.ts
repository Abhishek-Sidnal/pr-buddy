/**
 * Every size and time limit of the AI reviewer. Together they bound what one review can send,
 * accept and cost; see docs/DESIGN-AI.md.
 */

/** Files in one prompt. */
export const MAX_PROMPT_FILES = 50;
/** Characters of code lines in one prompt, over all files. */
export const MAX_PROMPT_CODE_LENGTH = 100_000;
/** Characters kept from one line; a longer line, usually minified code, is cut. */
export const MAX_PROMPT_LINE_LENGTH = 500;
export const MAX_PROMPT_DESCRIPTION_LENGTH = 4_000;

/** Output tokens a provider is asked to stay within. */
export const MAX_OUTPUT_TOKENS = 2_000;
/** Characters accepted in a reply; a longer one is rejected unread. */
export const MAX_RESPONSE_LENGTH = 50_000;
/** Suggestions looked at in one reply. */
export const MAX_AI_FINDINGS = 10;
export const MAX_AI_MESSAGE_LENGTH = 600;
export const MAX_AI_SUGGESTION_LENGTH = 600;

export const DEFAULT_AI_TIMEOUT_MS = 60_000;
export const MAX_AI_TIMEOUT_MS = 300_000;

/** Long enough for a Bedrock inference-profile ARN. */
export const MAX_PROVIDER_LABEL_LENGTH = 200;
/** Validation issues are published, so they are bounded. */
export const MAX_SETTINGS_ISSUE_LENGTH = 300;
