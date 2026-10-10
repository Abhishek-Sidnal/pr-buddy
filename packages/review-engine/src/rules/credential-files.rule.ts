import { z } from "zod";
import type { RuleFindingDraft } from "../findings/finding.schema.js";
import { createPathMatcher, globListSchema } from "../utils/glob.js";
import { pluralize } from "../utils/text.js";
import { defineRule, type RuleOutput } from "./rule.js";

/** A name suggests what a file holds; it does not prove it. */
const NAME_MATCH_CONFIDENCE = 0.8;

/** File names that conventionally hold secrets. */
export const CREDENTIAL_FILE_PATTERNS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/id_rsa",
  "**/id_dsa",
  "**/id_ecdsa",
  "**/id_ed25519",
  "**/.netrc",
  "**/.pgpass",
];

/** Templates that share a credential file's name but hold placeholders. */
export const CREDENTIAL_TEMPLATE_PATTERNS: readonly string[] = [
  "**/.env.example",
  "**/.env.sample",
  "**/.env.template",
  "**/.env.dist",
];

const optionsSchema = z.strictObject({
  /** Names of files that usually hold credentials. */
  patterns: globListSchema.default(() => [...CREDENTIAL_FILE_PATTERNS]),
  /** Files that match a pattern but are known to be safe, such as templates. */
  allow: globListSchema.default(() => [...CREDENTIAL_TEMPLATE_PATTERNS]),
  /** Files reported one by one; further ones are counted in a single finding. */
  maxFindings: z.number().int().min(1).max(50).default(10),
});

export const credentialFilesRule = defineRule({
  id: "credential-files",
  version: "1.0.0",
  description:
    "Reports added or edited files whose names say they usually hold credentials, such as .env and private keys.",
  defaultSeverity: "high",
  optionsSchema,
  run(context, options): RuleOutput {
    const isAllowed = createPathMatcher(options.allow);
    const matchers = options.patterns.map((pattern) => ({
      pattern,
      matches: createPathMatcher([pattern]),
    }));

    const findings: RuleFindingDraft[] = [];
    let unlisted = 0;
    for (const file of context.files) {
      // Removing such a file is the fix, not the problem.
      if (file.status === "removed" || isAllowed(file.path)) {
        continue;
      }
      const matched = matchers.find((matcher) => matcher.matches(file.path));
      if (matched === undefined) {
        continue;
      }
      if (findings.length >= options.maxFindings) {
        unlisted += 1;
        continue;
      }
      findings.push({
        confidence: NAME_MATCH_CONFIDENCE,
        message:
          "A file that usually holds credentials is part of the pull request. Its name was checked, not its contents.",
        evidence: [
          { label: "File", value: file.path },
          { label: "Matched pattern", value: matched.pattern },
        ],
        filePath: file.path,
        suggestion:
          "If it holds real credentials, remove it from the branch's history and replace the credentials. If it is a template, rename it or add it to the rule's allow list.",
      });
    }

    if (unlisted > 0) {
      findings.push({
        confidence: NAME_MATCH_CONFIDENCE,
        message: `${pluralize(unlisted, "more file")} that usually ${unlisted === 1 ? "holds" : "hold"} credentials ${unlisted === 1 ? "is" : "are"} part of the pull request.`,
        evidence: [
          { label: "Listed individually", value: String(options.maxFindings) },
          { label: "Not listed", value: String(unlisted) },
        ],
      });
    }
    return findings;
  },
});
