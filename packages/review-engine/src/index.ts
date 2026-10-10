export {
  createReviewEngine,
  type ConfiguredRule,
  type ReviewEngine,
  type ReviewEngineOptions,
} from "./engine/review-engine.js";
export type {
  Diagnostic,
  DiagnosticCode,
  ReviewResult,
  ReviewSummary,
  RuleExecution,
  RuleExecutionStatus,
} from "./engine/result.js";

export { defineRule, type ReviewRule, type RuleOutput } from "./rules/rule.js";
export { RuleRegistry } from "./rules/rule-registry.js";
export { builtinRules, createBuiltinRegistry } from "./rules/builtin.js";
export { prDescriptionRule } from "./rules/pr-description.rule.js";
export { maxChangedFilesRule } from "./rules/max-changed-files.rule.js";
export { missingTestChangesRule } from "./rules/missing-test-changes.rule.js";

export { parseReviewContext } from "./context/parse-context.js";
export {
  changedFileSchema,
  FILE_STATUSES,
  pullRequestSchema,
  reviewContextSchema,
  type ChangedFile,
  type FileStatus,
  type PullRequest,
  type ReviewContext,
} from "./context/context.schema.js";

export {
  engineConfigSchema,
  ruleSettingsSchema,
  type EngineConfig,
  type RuleSettings,
} from "./config/config.schema.js";

export {
  evidenceSchema,
  findingDraftSchema,
  findingSchema,
  type Evidence,
  type ReviewFinding,
  type RuleFindingDraft,
} from "./findings/finding.schema.js";
export { compareSeverity, SEVERITIES, severitySchema, type Severity } from "./findings/severity.js";

export { parsePatch, type PatchHunk } from "./diff/parse-patch.js";

export {
  MAX_BODY_LENGTH,
  MAX_FILES,
  MAX_PATCH_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_TOTAL_PATCH_LENGTH,
} from "./limits.js";

export {
  ConfigurationError,
  InvalidContextError,
  PrBuddyError,
  RuleDefinitionError,
  type ErrorCode,
} from "./errors.js";
