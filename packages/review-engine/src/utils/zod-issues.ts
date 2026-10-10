import type { z } from "zod";
import { MAX_ISSUE_LENGTH } from "../limits.js";
import { truncate } from "./text.js";

/** Formats Zod issues as "<path>: <message>" lines, optionally under a path prefix. */
export function formatZodIssues(error: z.ZodError, pathPrefix = ""): string[] {
  return error.issues.map((issue) => {
    const path = [pathPrefix, ...issue.path.map(String)].filter((part) => part !== "").join(".");
    return truncate(path === "" ? issue.message : `${path}: ${issue.message}`, MAX_ISSUE_LENGTH);
  });
}
