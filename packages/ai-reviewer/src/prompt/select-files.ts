import { getVisibleLines, type ChangedFile, type VisibleLine } from "@pr-buddy/review-engine";
import { MAX_PROMPT_CODE_LENGTH, MAX_PROMPT_FILES, MAX_PROMPT_LINE_LENGTH } from "../limits.js";
import { isNeverSentPath } from "../never-sent.js";

/** A changed file and the lines of it that are sent to the model. */
export interface SelectedFile {
  readonly file: ChangedFile;
  readonly lines: readonly VisibleLine[];
}

export interface FileSelection {
  readonly selected: readonly SelectedFile[];
  /** Files with changes to review that were left out: by name, or because they did not fit. */
  readonly omittedFileCount: number;
}

function shorten(line: VisibleLine): VisibleLine {
  return line.text.length <= MAX_PROMPT_LINE_LENGTH
    ? line
    : { ...line, text: line.text.slice(0, MAX_PROMPT_LINE_LENGTH) };
}

/**
 * Chooses what a model may see. A file is sent whole or not at all: a file cut in the middle
 * invites suggestions about code the model could not read. A file that does not fit is skipped
 * and smaller ones after it are still considered.
 */
export function selectFiles(files: readonly ChangedFile[]): FileSelection {
  const selected: SelectedFile[] = [];
  let omittedFileCount = 0;
  let remaining = MAX_PROMPT_CODE_LENGTH;

  for (const file of files) {
    // Nothing to review: the file is gone, binary, or its diff was too large to load.
    if (file.status === "removed" || file.patch === undefined) {
      continue;
    }
    if (isNeverSentPath(file.path)) {
      omittedFileCount += 1;
      continue;
    }
    const lines = getVisibleLines(file.patch).map(shorten);
    if (!lines.some((line) => line.isAdded)) {
      continue;
    }
    const length = lines.reduce((total, line) => total + line.text.length, 0);
    if (selected.length >= MAX_PROMPT_FILES || length > remaining) {
      omittedFileCount += 1;
      continue;
    }
    remaining -= length;
    selected.push({ file, lines });
  }
  return { selected, omittedFileCount };
}
