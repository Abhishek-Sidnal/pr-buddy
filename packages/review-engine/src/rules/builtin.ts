import { maxChangedFilesRule } from "./max-changed-files.rule.js";
import { missingTestChangesRule } from "./missing-test-changes.rule.js";
import { prDescriptionRule } from "./pr-description.rule.js";
import { RuleRegistry } from "./rule-registry.js";
import type { ReviewRule } from "./rule.js";

/** The rules shipped with PR Buddy, in the order they are reported. */
export const builtinRules: readonly ReviewRule[] = Object.freeze([
  prDescriptionRule,
  maxChangedFilesRule,
  missingTestChangesRule,
]);

/** Creates a new registry holding the built-in rules. Register custom rules on the result. */
export function createBuiltinRegistry(): RuleRegistry {
  return new RuleRegistry(builtinRules);
}
