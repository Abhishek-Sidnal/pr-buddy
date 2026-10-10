import { z } from "zod";
import { hasContentChanges } from "../context/changed-file.js";
import { MAX_EVIDENCE_VALUE_LENGTH } from "../limits.js";
import { createPathMatcher, globListSchema } from "../utils/glob.js";
import { pluralize, summarizeList, truncate } from "../utils/text.js";
import {
  SCRIPT_FILE_PATTERNS,
  TEST_FILE_PATTERNS,
  UNTESTED_SOURCE_PATTERNS,
} from "./file-patterns.js";
import { defineRule } from "./rule.js";

/** A missing test-file change is a hint, not proof, so the finding is reported below 1. */
const SIGNAL_CONFIDENCE = 0.6;
const MAX_LISTED_FILES = 5;

const optionsSchema = z.strictObject({
  /** Files whose changes are expected to come with test changes. */
  sourcePatterns: globListSchema.min(1).default(() => [...SCRIPT_FILE_PATTERNS]),
  /** The repository's convention for where tests live. */
  testPatterns: globListSchema.min(1).default(() => [...TEST_FILE_PATTERNS]),
  /** Source files that are exempt, such as type declarations and tool configuration. */
  ignorePatterns: globListSchema.default(() => [...UNTESTED_SOURCE_PATTERNS]),
});

export const missingTestChangesRule = defineRule({
  id: "missing-test-changes",
  version: "1.0.0",
  description:
    "Reports a pull request that edits source files without editing any file matching the repository's test conventions.",
  defaultSeverity: "low",
  optionsSchema,
  run(context, options) {
    const isSource = createPathMatcher(options.sourcePatterns);
    const isTest = createPathMatcher(options.testPatterns);
    const isIgnored = createPathMatcher(options.ignorePatterns);

    const editedPaths = context.files.filter(hasContentChanges).map((file) => file.path);
    if (editedPaths.some(isTest)) {
      return [];
    }

    const sourcePaths = editedPaths.filter((path) => isSource(path) && !isIgnored(path));
    if (sourcePaths.length === 0) {
      return [];
    }

    return [
      {
        confidence: SIGNAL_CONFIDENCE,
        message:
          `The pull request edits ${pluralize(sourcePaths.length, "source file")} but no test files. ` +
          "This is a signal, not proof: existing tests may already cover the change.",
        evidence: [
          {
            label: "Edited source files",
            value: truncate(
              summarizeList(sourcePaths, MAX_LISTED_FILES),
              MAX_EVIDENCE_VALUE_LENGTH,
            ),
          },
          {
            label: "Test file patterns checked",
            value: truncate(options.testPatterns.join(", "), MAX_EVIDENCE_VALUE_LENGTH),
          },
        ],
        suggestion:
          "If the change affects behaviour, add or update tests. If existing tests already cover it, no action is needed.",
      },
    ];
  },
});
