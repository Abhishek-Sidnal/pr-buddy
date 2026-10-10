import { z } from "zod";
import { MAX_RULE_ID_LENGTH } from "../limits.js";

/** Rule IDs are kebab-case: lowercase words of letters and digits joined by single hyphens. */
export const ruleIdSchema = z
  .string()
  .max(MAX_RULE_ID_LENGTH)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "must be kebab-case, for example max-changed-files");
