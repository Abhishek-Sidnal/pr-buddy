import { InvalidContextError } from "../errors.js";
import { deepFreeze } from "../utils/deep-freeze.js";
import { formatZodIssues } from "../utils/zod-issues.js";
import { reviewContextSchema, type ReviewContext } from "./context.schema.js";

/**
 * Validates untrusted review input and returns a frozen copy of it.
 * @throws {InvalidContextError} listing every problem found.
 */
export function parseReviewContext(input: unknown): ReviewContext {
  const parsed = reviewContextSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidContextError(formatZodIssues(parsed.error));
  }
  return deepFreeze(parsed.data);
}
