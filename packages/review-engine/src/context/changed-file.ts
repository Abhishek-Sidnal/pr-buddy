import type { ChangedFile } from "./context.schema.js";

/**
 * True when the file still exists after the change and its content was edited. Removed files,
 * pure renames and mode-only changes return false.
 */
export function hasContentChanges(file: ChangedFile): boolean {
  return file.status !== "removed" && file.additions + file.deletions > 0;
}
