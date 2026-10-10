import { z } from "zod";
import type { RuleFindingDraft } from "../findings/finding.schema.js";
import { addedLinesOf } from "../context/changed-file.js";
import { createPathMatcher, globListSchema } from "../utils/glob.js";
import { pluralize } from "../utils/text.js";
import { SCRIPT_FILE_PATTERNS, TEST_FILE_PATTERNS } from "./file-patterns.js";
import { defineRule, type RuleOutput } from "./rule.js";

/** The rule matches text, which can also appear inside a string, so it is not certain. */
const TEXT_MATCH_CONFIDENCE = 0.9;
/** Longer lines are minified or generated code, not something a person just typed. */
const MAX_LINE_LENGTH = 1_000;
const DEBUGGER_STATEMENT = /^\s*debugger\s*;?\s*(?:\/\/.*)?$/;
const COMMENT_START = /^\s*(?:\/\/|\/\*|\*)/;

const optionsSchema = z.strictObject({
  /** `console` methods that count as debugging. `warn` and `error` are left alone by default. */
  consoleMethods: z
    .array(z.string().regex(/^[A-Za-z]{1,30}$/, "must be a method name"))
    .max(30)
    .default(() => ["log", "debug", "trace", "table", "dir"]),
  /** Files that are checked. */
  include: globListSchema.default(() => [...SCRIPT_FILE_PATTERNS]),
  /** Files that are not checked, even if included. Tests may log freely by default. */
  exclude: globListSchema.default(() => [...TEST_FILE_PATTERNS]),
  /** Statements reported one by one; further ones are counted in a single finding. */
  maxFindings: z.number().int().min(1).max(50).default(10),
});

/** Returns what was found on a line, such as "console.log", or `undefined`. */
function createDetector(consoleMethods: readonly string[]): (text: string) => string | undefined {
  // Method names are validated as plain letters, so they are safe to place in the expression.
  const consoleCall =
    consoleMethods.length === 0
      ? undefined
      : new RegExp(`\\bconsole\\.(${consoleMethods.join("|")})\\s*\\(`);

  return (text) => {
    if (text.length > MAX_LINE_LENGTH || COMMENT_START.test(text)) {
      return undefined;
    }
    if (DEBUGGER_STATEMENT.test(text)) {
      return "debugger";
    }
    const method = consoleCall?.exec(text)?.[1];
    return method === undefined ? undefined : `console.${method}`;
  };
}

export const debugStatementsRule = defineRule({
  id: "debug-statements",
  version: "1.0.0",
  description: "Reports debugging statements, such as console.log and debugger, on added lines.",
  defaultSeverity: "low",
  optionsSchema,
  run(context, options): RuleOutput {
    const isIncluded = createPathMatcher(options.include);
    const isExcluded = createPathMatcher(options.exclude);
    const detect = createDetector(options.consoleMethods);

    const findings: RuleFindingDraft[] = [];
    let unlisted = 0;
    for (const file of context.files) {
      if (!isIncluded(file.path) || isExcluded(file.path)) {
        continue;
      }
      for (const { line, text } of addedLinesOf(file)) {
        const statement = detect(text);
        if (statement === undefined) {
          continue;
        }
        if (findings.length >= options.maxFindings) {
          unlisted += 1;
          continue;
        }
        findings.push({
          confidence: TEXT_MATCH_CONFIDENCE,
          message: `A ${statement} statement was added.`,
          // The line itself is not quoted: findings are stored and published, source is not.
          evidence: [{ label: "Statement", value: statement }],
          filePath: file.path,
          line,
          suggestion:
            "Remove it before merging, or use the project's logger if the output is wanted.",
        });
      }
    }

    if (unlisted > 0) {
      findings.push({
        confidence: TEXT_MATCH_CONFIDENCE,
        message: `${pluralize(unlisted, "more debugging statement")} ${unlisted === 1 ? "was" : "were"} added and ${unlisted === 1 ? "is" : "are"} not listed one by one.`,
        evidence: [
          { label: "Listed individually", value: String(options.maxFindings) },
          { label: "Not listed", value: String(unlisted) },
        ],
      });
    }
    return findings;
  },
});
