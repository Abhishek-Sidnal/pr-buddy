import { z } from "zod";
import { MAX_EVIDENCE_VALUE_LENGTH } from "../limits.js";
import { createPathMatcher, globListSchema } from "../utils/glob.js";
import { pluralize, summarizeList, truncate } from "../utils/text.js";
import { defineRule } from "./rule.js";

const MAX_LISTED_FILES = 5;

/** Files that decide how the project is built, deployed, installed or reviewed. */
export const SENSITIVE_FILE_PATTERNS: readonly string[] = [
  ".github/workflows/**",
  ".github/actions/**",
  ".github/dependabot.yml",
  ".github/pr-buddy.json",
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/*.Dockerfile",
  "**/docker-compose*.{yml,yaml}",
  "**/compose*.{yml,yaml}",
  "**/.npmrc",
];

const optionsSchema = z.strictObject({
  /** Files whose changes deserve a careful look. */
  patterns: globListSchema.min(1).default(() => [...SENSITIVE_FILE_PATTERNS]),
});

export const sensitiveFileChangesRule = defineRule({
  id: "sensitive-file-changes",
  version: "1.0.0",
  description:
    "Reports changes to files that control builds, deployment, dependencies or review, such as CI workflows and Dockerfiles.",
  defaultSeverity: "medium",
  optionsSchema,
  run(context, options) {
    const isSensitive = createPathMatcher(options.patterns);
    const paths = context.files.map((file) => file.path).filter(isSensitive);
    if (paths.length === 0) {
      return [];
    }

    return [
      {
        // This states a fact about which files changed; whether the change is right is for a person.
        message: `The pull request changes ${pluralize(paths.length, "file")} that ${paths.length === 1 ? "controls" : "control"} how the project is built, deployed or reviewed.`,
        evidence: [
          {
            label: "Files",
            value: truncate(summarizeList(paths, MAX_LISTED_FILES), MAX_EVIDENCE_VALUE_LENGTH),
          },
        ],
        suggestion: "Have someone who owns these files look at the change.",
      },
    ];
  },
});
