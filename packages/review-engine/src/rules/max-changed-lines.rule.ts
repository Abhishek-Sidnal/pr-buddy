import { z } from "zod";
import { createPathMatcher, globListSchema } from "../utils/glob.js";
import { LOCKFILE_PATTERNS } from "./file-patterns.js";
import { defineRule } from "./rule.js";

const optionsSchema = z.strictObject({
  /** Largest number of added plus removed lines that is not reported. */
  maxLines: z.number().int().min(1).max(10_000_000).default(1_000),
  /** Glob patterns of files whose lines do not count towards the limit. */
  exclude: globListSchema.default(() => [...LOCKFILE_PATTERNS]),
});

export const maxChangedLinesRule = defineRule({
  id: "max-changed-lines",
  version: "1.0.0",
  description:
    "Reports a pull request that adds and removes more lines than the configured maximum.",
  defaultSeverity: "medium",
  optionsSchema,
  run(context, options) {
    const isExcluded = createPathMatcher(options.exclude);
    const counted = context.files.filter((file) => !isExcluded(file.path));
    const changedLines = counted.reduce(
      (total, file) => total + file.additions + file.deletions,
      0,
    );
    if (changedLines <= options.maxLines) {
      return [];
    }

    const excludedFiles = context.files.length - counted.length;
    return [
      {
        message: `The pull request changes ${changedLines} lines, more than the configured maximum of ${options.maxLines}.`,
        evidence: [
          { label: "Lines added and removed", value: String(changedLines) },
          { label: "Configured maximum", value: String(options.maxLines) },
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
