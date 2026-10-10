import { z } from "zod";
import { resolveRules } from "../config/resolve-config.js";
import { parseReviewContext } from "../context/parse-context.js";
import { ConfigurationError } from "../errors.js";
import { createLocationValidator } from "../findings/finding-location.js";
import { dedupeFindings, sortFindings } from "../findings/finding-order.js";
import type { Severity } from "../findings/severity.js";
import { DEFAULT_RULE_TIMEOUT_MS, MAX_RULE_TIMEOUT_MS } from "../limits.js";
import { createBuiltinRegistry } from "../rules/builtin.js";
import type { RuleRegistry } from "../rules/rule-registry.js";
import { formatZodIssues } from "../utils/zod-issues.js";
import { summarizeFindings, type ReviewResult } from "./result.js";
import { runRule } from "./run-rule.js";

export interface ReviewEngineOptions {
  /** Rules available to the engine. Defaults to the built-in rules. */
  readonly registry?: RuleRegistry;
  /** Untrusted configuration; see `engineConfigSchema`. Defaults to every rule's defaults. */
  readonly config?: unknown;
  /** Time limit for one rule, in milliseconds. */
  readonly ruleTimeoutMs?: number;
}

/** A registered rule and the settings this engine runs it with. */
export interface ConfiguredRule {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly enabled: boolean;
  /** Severity of the rule's findings unless a finding sets its own. */
  readonly severity: Severity;
}

export interface ReviewEngine {
  readonly rules: readonly ConfiguredRule[];
  /**
   * Reviews one pull request. `context` is untrusted and validated first.
   * Rejects with `InvalidContextError` if it is invalid; rule failures do not reject.
   */
  review(context: unknown): Promise<ReviewResult>;
}

const ruleTimeoutSchema = z.number().int().min(1).max(MAX_RULE_TIMEOUT_MS);

function parseRuleTimeout(value: number | undefined): number {
  const parsed = ruleTimeoutSchema.safeParse(value ?? DEFAULT_RULE_TIMEOUT_MS);
  if (!parsed.success) {
    throw new ConfigurationError(formatZodIssues(parsed.error, "ruleTimeoutMs"));
  }
  return parsed.data;
}

/**
 * Creates a review engine. Configuration is validated here, once, so a mistake is reported
 * before any pull request is reviewed.
 * @throws {ConfigurationError}
 */
export function createReviewEngine(options: ReviewEngineOptions = {}): ReviewEngine {
  const resolvedRules = resolveRules(options.registry ?? createBuiltinRegistry(), options.config);
  const ruleTimeoutMs = parseRuleTimeout(options.ruleTimeoutMs);

  return {
    rules: resolvedRules.map(({ rule, enabled, severityOverride }) => ({
      id: rule.id,
      version: rule.version,
      description: rule.description,
      enabled,
      severity: severityOverride ?? rule.defaultSeverity,
    })),

    async review(input) {
      const context = parseReviewContext(input);
      const validateLocation = createLocationValidator(context.files);

      // Rules are independent and see the same frozen context, so they can run concurrently.
      const outcomes = await Promise.all(
        resolvedRules.map((resolved) =>
          runRule(resolved, context, validateLocation, ruleTimeoutMs),
        ),
      );

      const findings = sortFindings(
        dedupeFindings(outcomes.flatMap((outcome) => outcome.findings)),
      );
      const { number, baseSha, headSha } = context.pullRequest;
      return {
        pullRequest: { number, baseSha, headSha },
        findings,
        rules: outcomes.map((outcome) => outcome.execution),
        diagnostics: outcomes.flatMap((outcome) => outcome.diagnostics),
        summary: summarizeFindings(findings),
      };
    },
  };
}
