export interface PatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** New-side line numbers of added ("+") lines. */
  readonly addedLines: readonly number[];
  /** The text of each added line, without its "+", in the same order as `addedLines`. */
  readonly addedLineTexts: readonly string[];
  /** New-side line numbers of unchanged (" ") lines. */
  readonly contextLines: readonly number[];
  /** The text of each unchanged line, without its leading space, in the same order. */
  readonly contextLineTexts: readonly string[];
  /**
   * True when the hunk holds exactly the lines its header declares. A hunk that is cut short or
   * has extra lines cannot be trusted, and its line numbers must not be used to verify anything.
   */
  readonly isWellFormed: boolean;
}

/** `@@ -oldStart[,oldLines] +newStart[,newLines] @@`; a missing count means 1. */
const HUNK_HEADER = /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+(\d{1,9})(?:,(\d{1,9}))? @@/;

interface HunkCursor {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly addedLines: number[];
  readonly addedLineTexts: string[];
  readonly contextLines: number[];
  readonly contextLineTexts: string[];
  nextNewLine: number;
  remainingOld: number;
  remainingNew: number;
  /** Set when a diff line appears after the declared number of lines has been read. */
  hasExtraLines: boolean;
}

function openHunk(header: RegExpExecArray): HunkCursor {
  const oldLines = header[2] === undefined ? 1 : Number(header[2]);
  const newStart = Number(header[3]);
  const newLines = header[4] === undefined ? 1 : Number(header[4]);
  return {
    oldStart: Number(header[1]),
    oldLines,
    newStart,
    newLines,
    addedLines: [],
    addedLineTexts: [],
    contextLines: [],
    contextLineTexts: [],
    nextNewLine: newStart,
    remainingOld: oldLines,
    remainingNew: newLines,
    hasExtraLines: false,
  };
}

function closeHunk(cursor: HunkCursor): PatchHunk {
  return {
    oldStart: cursor.oldStart,
    oldLines: cursor.oldLines,
    newStart: cursor.newStart,
    newLines: cursor.newLines,
    addedLines: cursor.addedLines,
    addedLineTexts: cursor.addedLineTexts,
    contextLines: cursor.contextLines,
    contextLineTexts: cursor.contextLineTexts,
    isWellFormed: cursor.remainingOld === 0 && cursor.remainingNew === 0 && !cursor.hasExtraLines,
  };
}

function consumeLine(cursor: HunkCursor, line: string): void {
  const marker = line.charAt(0);
  if (marker === "+") {
    if (cursor.remainingNew > 0) {
      cursor.addedLines.push(cursor.nextNewLine);
      cursor.addedLineTexts.push(line.slice(1));
      cursor.nextNewLine += 1;
      cursor.remainingNew -= 1;
    } else {
      cursor.hasExtraLines = true;
    }
  } else if (marker === "-") {
    if (cursor.remainingOld > 0) {
      cursor.remainingOld -= 1;
    } else {
      cursor.hasExtraLines = true;
    }
  } else if (marker === " " || marker === "") {
    // Some tools strip the single space of an empty context line, leaving an empty string.
    if (cursor.remainingOld > 0 && cursor.remainingNew > 0) {
      cursor.contextLines.push(cursor.nextNewLine);
      cursor.contextLineTexts.push(line.slice(1));
      cursor.nextNewLine += 1;
      cursor.remainingOld -= 1;
      cursor.remainingNew -= 1;
    } else {
      cursor.hasExtraLines = true;
    }
  }
  // Anything else, including "\ No newline at end of file", has no line number.
}

/** Splits a patch into lines. A final newline ends the last line; it does not start another. */
function splitLines(patch: string): string[] {
  const lines = patch.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Parses the hunks of a unified-diff patch for one file, as returned by the GitHub API.
 *
 * Text outside a hunk is ignored. Each hunk reports whether it matched its header, so callers
 * can refuse to rely on one that did not.
 */
export function parsePatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let cursor: HunkCursor | undefined;

  for (const line of splitLines(patch)) {
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      if (cursor !== undefined) {
        hunks.push(closeHunk(cursor));
      }
      cursor = openHunk(header);
    } else if (cursor !== undefined) {
      consumeLine(cursor, line);
    }
  }
  if (cursor !== undefined) {
    hunks.push(closeHunk(cursor));
  }
  return hunks;
}

/**
 * Line numbers that exist in the file after the change and are visible in the patch. Only
 * well-formed hunks contribute, so a malformed patch yields fewer lines, never invented ones.
 */
export function getNewSideLines(patch: string): Set<number> {
  const lines = new Set<number>();
  for (const hunk of parsePatch(patch)) {
    if (!hunk.isWellFormed) {
      continue;
    }
    for (const line of hunk.addedLines) {
      lines.add(line);
    }
    for (const line of hunk.contextLines) {
      lines.add(line);
    }
  }
  return lines;
}

/** One line that a change adds to a file. */
export interface AddedLine {
  /** 1-based line number in the file after the change. */
  readonly line: number;
  readonly text: string;
}

/**
 * The lines a patch adds, with their text. Like `getNewSideLines`, it reads well-formed hunks
 * only, so every line it returns can be used as a verified location.
 */
export function getAddedLines(patch: string): AddedLine[] {
  const added: AddedLine[] = [];
  for (const hunk of parsePatch(patch)) {
    if (!hunk.isWellFormed) {
      continue;
    }
    hunk.addedLines.forEach((line, index) => {
      added.push({ line, text: hunk.addedLineTexts[index] ?? "" });
    });
  }
  return added;
}

/** One line of a file after a change, as far as its patch shows it. */
export interface VisibleLine {
  /** 1-based line number in the file after the change. */
  readonly line: number;
  readonly text: string;
  /** True for a line the change adds; false for an unchanged line shown for context. */
  readonly isAdded: boolean;
}

/**
 * Every new-side line a patch shows, added and unchanged, in file order. These are exactly the
 * lines `getNewSideLines` accepts as locations, with their text.
 */
export function getVisibleLines(patch: string): VisibleLine[] {
  const visible: VisibleLine[] = [];
  for (const hunk of parsePatch(patch)) {
    if (!hunk.isWellFormed) {
      continue;
    }
    hunk.addedLines.forEach((line, index) => {
      visible.push({ line, text: hunk.addedLineTexts[index] ?? "", isAdded: true });
    });
    hunk.contextLines.forEach((line, index) => {
      visible.push({ line, text: hunk.contextLineTexts[index] ?? "", isAdded: false });
    });
  }
  return visible.sort((a, b) => a.line - b.line);
}
