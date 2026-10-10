import { z } from "zod";
import { MAX_FILES } from "../limits.js";
import { createPathMatcher, globListSchema } from "../utils/glob.js";
import { LOCKFILE_PATTERNS } from "./file-patterns.js";
import { defineRule } from "./rule.js";

const optionsSchema = z.strictObject({
  /** Largest number of changed files that is not reported. */
  maxFiles: z.number().int().min(1).max(MAX_FILES).default(30),
  /** Glob patterns of files that do not count towards the limit. */
  exclude: globListSchema.default(() => [...LOCKFILE_PATTERNS]),
});

export const maxChangedFilesRule = defineRule({
  id: "max-changed-files",
  version: "1.0.0",
  description: "Reports a pull request that changes more files than the configured maximum.",
  defaultSeverity: "medium",
  optionsSchema,
  run(context, options) {
    const isExcluded = createPathMatcher(options.exclude);
    const countedFiles = context.files.filter((file) => !isExcluded(file.path)).length;
    if (countedFiles <= options.maxFiles) {
      return [];
    }

    const excludedFiles = context.files.length - countedFiles;
    return [
      {
        message: `The pull request changes ${countedFiles} files, more than the configured maximum of ${options.maxFiles}.`,
        evidence: [
          { label: "Changed files counted", value: String(countedFiles) },
          { label: "Configured maximum", value: String(options.maxFiles) },
          ...(excludedFiles > 0
            ? [{ label: "Files excluded from the count", value: String(excludedFiles) }]
            : []),
        ],
        suggestion:
          "Consider splitting the change into smaller pull requests that can be reviewed independently.",
      },
    ];
  },
});
