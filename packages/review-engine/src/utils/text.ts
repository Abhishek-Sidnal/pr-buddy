const ELLIPSIS = "…";

/** Shortens `text` to at most `maxLength` characters, marking the cut with an ellipsis. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, Math.max(0, maxLength - ELLIPSIS.length)) + ELLIPSIS;
}

/** Returns "1 file" or "3 files". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Joins the first `maxItems` items and notes how many were left out. */
export function summarizeList(items: readonly string[], maxItems: number): string {
  const shown = items.slice(0, maxItems).join(", ");
  const hidden = items.length - maxItems;
  return hidden > 0 ? `${shown} (and ${hidden} more)` : shown;
}
