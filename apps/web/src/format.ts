const SHORT_COMMIT_LENGTH = 7;
const ONE_SECOND_MS = 1_000;
const PERCENT = 100;

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** A time in the reader's own locale and time zone, or the raw text if it is not a time. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormat.format(date);
}

export function formatDuration(milliseconds: number): string {
  return milliseconds < ONE_SECOND_MS
    ? `${Math.round(milliseconds)} ms`
    : `${(milliseconds / ONE_SECOND_MS).toFixed(1)} s`;
}

export function shortCommit(commitId: string): string {
  return commitId.slice(0, SHORT_COMMIT_LENGTH);
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * PERCENT)}%`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
