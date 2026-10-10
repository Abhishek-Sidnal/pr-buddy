const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
const HEADING_LINE = /^ {0,3}#{1,6}(?:\s|$)/;

/**
 * Removes HTML comments. An unterminated comment hides the rest of the text, as it does when
 * GitHub renders the Markdown. Scans with `indexOf`, so cost is linear in the input.
 */
export function stripHtmlComments(text: string): string {
  let result = "";
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(COMMENT_OPEN, cursor);
    if (start === -1) {
      return result + text.slice(cursor);
    }
    result += text.slice(cursor, start);
    const end = text.indexOf(COMMENT_CLOSE, start + COMMENT_OPEN.length);
    if (end === -1) {
      return result;
    }
    cursor = end + COMMENT_CLOSE.length;
  }
}

/**
 * Reduces a Markdown description to the text its author wrote: HTML comments and heading lines
 * (the usual content of a pull request template) are dropped and whitespace is collapsed.
 */
export function extractMeaningfulText(markdown: string): string {
  return stripHtmlComments(markdown)
    .split("\n")
    .filter((line) => !HEADING_LINE.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
