/**
 * A hidden line in the runner's summary comment that names the commit it reviewed. The next run
 * reads it to tell that a commit was already reviewed, and how much changed since.
 */
const REVIEWED_MARKER = /<!-- pr-buddy:runner reviewed=([0-9a-f]{40}) -->/g;

/** The marker for a reviewed commit. */
export function renderReviewedMarker(headSha: string): string {
  return `<!-- pr-buddy:runner reviewed=${headSha} -->`;
}

/**
 * The commit a summary comment says was reviewed, or `undefined` if it does not say. Only a
 * full commit ID counts. If the comment holds several markers, the last one is taken: the
 * runner writes its own at the end, after anything a pull request could have put in the text.
 */
export function readReviewedCommit(commentBody: string | undefined): string | undefined {
  if (commentBody === undefined) {
    return undefined;
  }
  let last: string | undefined;
  for (const match of commentBody.matchAll(REVIEWED_MARKER)) {
    last = match[1];
  }
  return last;
}
