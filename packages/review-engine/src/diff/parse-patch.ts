export interface PatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** New-side line numbers of added ("+") lines. */
  readonly addedLines: readonly number[];
  /** New-side line numbers of unchanged (" ") lines. */
  readonly contextLines: readonly number[];
}

/** `@@ -oldStart[,oldLines] +newStart[,newLines] @@`; a missing count means 1. */
const HUNK_HEADER = /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+(\d{1,9})(?:,(\d{1,9}))? @@/;

interface HunkCursor {
  readonly hunk: PatchHunk;
  readonly addedLines: number[];
  readonly contextLines: number[];
  nextNewLine: number;
  remainingOld: number;
  remainingNew: number;
}

function openHunk(header: RegExpExecArray): HunkCursor {
  const oldStart = Number(header[1]);
  const oldLines = header[2] === undefined ? 1 : Number(header[2]);
  const newStart = Number(header[3]);
  const newLines = header[4] === undefined ? 1 : Number(header[4]);
  const addedLines: number[] = [];
  const contextLines: number[] = [];
  return {
    hunk: { oldStart, oldLines, newStart, newLines, addedLines, contextLines },
    addedLines,
    contextLines,
    nextNewLine: newStart,
    remainingOld: oldLines,
    remainingNew: newLines,
  };
}

function consumeLine(cursor: HunkCursor, line: string): void {
  const marker = line.charAt(0);
  if (marker === "+") {
    if (cursor.remainingNew > 0) {
      cursor.addedLines.push(cursor.nextNewLine);
      cursor.nextNewLine += 1;
      cursor.remainingNew -= 1;
    }
  } else if (marker === "-") {
    if (cursor.remainingOld > 0) {
      cursor.remainingOld -= 1;
    }
  } else if (marker === " " || marker === "") {
    // Some tools strip the single space of an empty context line.
    if (cursor.remainingOld > 0 && cursor.remainingNew > 0) {
      cursor.contextLines.push(cursor.nextNewLine);
      cursor.nextNewLine += 1;
      cursor.remainingOld -= 1;
      cursor.remainingNew -= 1;
    }
  }
  // Anything else, including "\ No newline at end of file", has no line number.
}

/**
 * Parses the hunks of a unified-diff patch for one file, as returned by the GitHub API.
 *
 * The parser is tolerant: text outside a hunk and lines beyond a hunk's declared size are
 * ignored. A malformed patch therefore yields fewer line numbers, never incorrect ones.
 */
export function parsePatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let cursor: HunkCursor | undefined;

  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      cursor = openHunk(header);
      hunks.push(cursor.hunk);
    } else if (cursor !== undefined) {
      consumeLine(cursor, line);
    }
  }
  return hunks;
}

/** Line numbers that exist in the file after the change and are visible in the patch. */
export function getNewSideLines(patch: string): Set<number> {
  const lines = new Set<number>();
  for (const hunk of parsePatch(patch)) {
    for (const line of hunk.addedLines) {
      lines.add(line);
    }
    for (const line of hunk.contextLines) {
      lines.add(line);
    }
  }
  return lines;
}
