import { ConfigurationError } from "../errors.js";
import type { Severity } from "../findings/severity.js";
import { MAX_RULE_ID_LENGTH } from "../limits.js";
import type { RuleRegistry } from "../rules/rule-registry.js";
import type { ReviewRule } from "../rules/rule.js";
import { deepFreeze } from "../utils/deep-freeze.js";
import { truncate } from "../utils/text.js";
import { formatZodIssues } from "../utils/zod-issues.js";
import { engineConfigSchema, type RuleSettings } from "./config.schema.js";

/** A registered rule together with the settings the engine will run it with. */
export interface ResolvedRule {
  readonly rule: ReviewRule;
  readonly enabled: boolean;
  /** Severity from the configuration, which takes precedence over the rule's own choice. */
  readonly severityOverride: Severity | undefined;
  /** Options after validation by the rule's schema, with defaults applied. */
  readonly options: unknown;
}

/**
 * Validates untrusted configuration and resolves the settings of every registered rule.
 * All problems are collected and reported together.
 * @throws {ConfigurationError}
 */
export function resolveRules(registry: RuleRegistry, rawConfig: unknown): readonly ResolvedRule[] {
  const parsed = engineConfigSchema.safeParse(rawConfig ?? {});
  if (!parsed.success) {
    throw new ConfigurationError(formatZodIssues(parsed.error));
  }

  const settingsByRuleId = new Map<string, RuleSettings>(Object.entries(parsed.data.rules ?? {}));
  const rules = registry.list();
  const issues: string[] = [];

  for (const ruleId of settingsByRuleId.keys()) {
    if (!registry.has(ruleId)) {
      const known = rules.map((rule) => rule.id).join(", ");
      // The ID comes from untrusted configuration, so it is bounded before being quoted.
      const quotedId = truncate(ruleId, MAX_RULE_ID_LENGTH);
      issues.push(`rules.${quotedId}: unknown rule. Registered rules: ${known}`);
    }
  }

  const resolved: ResolvedRule[] = [];
  for (const rule of rules) {
    const settings = settingsByRuleId.get(rule.id);
    const options = rule.optionsSchema.safeParse(settings?.options ?? {});
    if (options.success) {
      resolved.push({
        rule,
        enabled: settings?.enabled ?? true,
        severityOverride: settings?.severity,
        options: deepFreeze(options.data),
      });
    } else {
      issues.push(...formatZodIssues(options.error, `rules.${rule.id}.options`));
    }
  }

  if (issues.length > 0) {
    throw new ConfigurationError(issues);
  }
  return resolved;
}

/** The least a finding must be to be reported. */
export interface ReportThresholds {
  readonly minSeverity: Severity;
  readonly minConfidence: number;
}

/** Thresholds that hide nothing. */
export const REPORT_EVERYTHING: ReportThresholds = { minSeverity: "low", minConfidence: 0 };

/**
 * Validates untrusted configuration and returns its reporting thresholds.
 * @throws {ConfigurationError}
 */
export function resolveReportThresholds(rawConfig: unknown): ReportThresholds {
  const parsed = engineConfigSchema.safeParse(rawConfig ?? {});
  if (!parsed.success) {
    throw new ConfigurationError(formatZodIssues(parsed.error));
  }
  return {
    minSeverity: parsed.data.report?.minSeverity ?? REPORT_EVERYTHING.minSeverity,
    minConfidence: parsed.data.report?.minConfidence ?? REPORT_EVERYTHING.minConfidence,
  };
}
