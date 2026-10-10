import { z } from "zod";
import { MAX_PATH_LENGTH } from "../limits.js";

const FIRST_PRINTABLE_CODE = 0x20;
const DELETE_CODE = 0x7f;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < FIRST_PRINTABLE_CODE || code === DELETE_CODE) {
      return true;
    }
  }
  return false;
}

/**
 * Explains why a path is not a safe repository-relative path, or returns `undefined` if it is.
 * Safe means: relative, forward slashes only, no "." or ".." segments, no control characters.
 */
export function describeUnsafeRepoPath(path: string): string | undefined {
  if (hasControlCharacter(path)) {
    return "must not contain control characters";
  }
  if (path.includes("\\")) {
    return "must use forward slashes";
  }
  if (path.startsWith("/")) {
    return "must be relative to the repository root";
  }
  for (const segment of path.split("/")) {
    if (segment === "") {
      return "must not contain empty path segments";
    }
    if (segment === "." || segment === "..") {
      return 'must not contain "." or ".." segments';
    }
  }
  return undefined;
}

export const repoPathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .superRefine((path, ctx) => {
    const problem = describeUnsafeRepoPath(path);
    if (problem !== undefined) {
      ctx.addIssue({ code: "custom", message: problem });
    }
  });
