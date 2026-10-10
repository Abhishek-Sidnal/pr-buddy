const ZERO_WIDTH_SPACE = "​";
/** Characters with a meaning in GitHub-flavoured Markdown, each neutralised by a backslash. */
const MARKDOWN_SPECIALS = /[\\`*_{}[\]()#+\-.!|<>~]/g;

/**
 * Makes text safe to place in a Markdown paragraph: it renders as written and cannot start a
 * link, HTML element or formatting. `@` is followed by an invisible character so that it never
 * notifies a user or team.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(MARKDOWN_SPECIALS, "\\$&")
    .replace(/@/g, `@${ZERO_WIDTH_SPACE}`);
}

/**
 * Wraps text in an inline code span, where nothing is interpreted: no mentions, links or HTML.
 * The fence is made longer than any run of backticks inside the text.
 */
export function inlineCode(text: string): string {
  const singleLine = text.replace(/\s+/g, " ");
  let longestRun = 0;
  for (const run of singleLine.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, run[0].length);
  }
  const fence = "`".repeat(longestRun + 1);
  return `${fence} ${singleLine} ${fence}`;
}
