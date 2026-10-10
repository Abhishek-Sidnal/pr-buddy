import type { ResolvedRule } from "../config/resolve-config.js";
import type { ReviewContext } from "../context/context.schema.js";
import type { LocationValidator } from "../findings/finding-location.js";
import {
  findingDraftSchema,
  type ReviewFinding,
  type RuleFindingDraft,
} from "../findings/finding.schema.js";
import { MAX_ERROR_MESSAGE_LENGTH, MAX_FINDINGS_PER_RULE } from "../limits.js";
import { truncate } from "../utils/text.js";
import { withTimeout } from "../utils/timeout.js";
import { formatZodIssues } from "../utils/zod-issues.js";
import type { Diagnostic, RuleExecution } from "./result.js";

/** Confidence of a finding whose rule did not state one: deterministic rules report facts. */
const DEFAULT_CONFIDENCE = 1;

export interface RuleRunOutcome {
  readonly execution: RuleExecution;
  readonly findings: readonly ReviewFinding[];
  readonly diagnostics: readonly Diagnostic[];
}

function describeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "The rule threw a value that is not an Error.";
  return truncate(message, MAX_ERROR_MESSAGE_LENGTH);
}

/** Adds what only the engine may decide: the rule's identity and the resolved severity. */
function stampFinding(draft: RuleFindingDraft, resolved: ResolvedRule): ReviewFinding {
  const { severity, confidence, ...details } = draft;
  return {
    ruleId: resolved.rule.id,
    severity: resolved.severityOverride ?? severity ?? resolved.rule.defaultSeverity,
    confidence: confidence ?? DEFAULT_CONFIDENCE,
    ...details,
  };
}

/**
 * Runs one rule in isolation. Never throws: an error or timeout is reported in the execution
 * record, and anything invalid the rule returns is dropped with a diagnostic.
 */
export async function runRule(
  resolved: ResolvedRule,
  context: ReviewContext,
  validateLocation: LocationValidator,
  timeoutMs: number,
): Promise<RuleRunOutcome> {
  const { rule } = resolved;
  const identity = { ruleId: rule.id, ruleVersion: rule.version };

  if (!resolved.enabled) {
    return {
      execution: { ...identity, status: "disabled", findingCount: 0, durationMs: 0 },
      findings: [],
      diagnostics: [],
    };
  }

  const startedAt = performance.now();
  const elapsedMs = (): number => Math.round(performance.now() - startedAt);
  const failed = (error: string): RuleRunOutcome => ({
    execution: { ...identity, status: "failed", findingCount: 0, durationMs: elapsedMs(), error },
    findings: [],
    diagnostics: [],
  });

  let output: unknown;
  try {
    output = await withTimeout(() => rule.run(context, resolved.options), timeoutMs);
  } catch (error) {
    return failed(describeError(error));
  }
  if (!Array.isArray(output)) {
    return failed("The rule did not return an array of findings.");
  }

  const drafts: readonly unknown[] = output;
  const findings: ReviewFinding[] = [];
  const diagnostics: Diagnostic[] = [];

  if (drafts.length > MAX_FINDINGS_PER_RULE) {
    diagnostics.push({
      ruleId: rule.id,
      code: "FINDINGS_TRUNCATED",
      message: `The rule returned ${drafts.length} findings; only the first ${MAX_FINDINGS_PER_RULE} were kept.`,
    });
  }

  drafts.slice(0, MAX_FINDINGS_PER_RULE).forEach((draft, index) => {
    const parsed = findingDraftSchema.safeParse(draft);
    if (!parsed.success) {
      diagnostics.push({
        ruleId: rule.id,
        code: "FINDING_REJECTED",
        message: `Finding ${index} was rejected: ${formatZodIssues(parsed.error).join("; ")}`,
      });
      return;
    }

    const checked = validateLocation(stampFinding(parsed.data, resolved));
    if (checked.removalReason !== undefined) {
      diagnostics.push({
        ruleId: rule.id,
        code: "LOCATION_REMOVED",
        message: `Finding ${index} lost its location: ${checked.removalReason}.`,
      });
    }
    findings.push(checked.finding);
  });

  return {
    execution: {
      ...identity,
      status: "completed",
      findingCount: findings.length,
      durationMs: elapsedMs(),
    },
    findings,
    diagnostics,
  };
}
