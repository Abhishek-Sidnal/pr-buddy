import { getAddedLines, type AddedLine } from "../diff/parse-patch.js";
import type { ChangedFile } from "./context.schema.js";

/**
 * True when the file still exists after the change and its content was edited. Removed files,
 * pure renames and mode-only changes return false.
 */
export function hasContentChanges(file: ChangedFile): boolean {
  return file.status !== "removed" && file.additions + file.deletions > 0;
}

/**
 * The lines a change adds to a file, with their text. Empty for removed files and for files
 * without a patch, such as binary files.
 */
export function addedLinesOf(file: ChangedFile): AddedLine[] {
  return file.status === "removed" || file.patch === undefined ? [] : getAddedLines(file.patch);
}
