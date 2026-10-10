import type { ReviewFinding } from "../findings/finding.schema.js";
import { highestSeverity, SEVERITIES, type Severity } from "../findings/severity.js";

export type RuleExecutionStatus = "completed" | "disabled" | "failed";

/** What happened to one registered rule during a review. */
export interface RuleExecution {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly status: RuleExecutionStatus;
  readonly findingCount: number;
  readonly durationMs: number;
  /** Present when `status` is "failed". For operators and logs; do not publish it. */
  readonly error?: string;
}

export type DiagnosticCode = "FINDING_REJECTED" | "FINDINGS_TRUNCATED" | "LOCATION_REMOVED";

/** A note that the engine rejected or corrected something a rule returned. */
export interface Diagnostic {
  readonly ruleId: string;
  readonly code: DiagnosticCode;
  readonly message: string;
}

export interface ReviewSummary {
  readonly total: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  /** Absent when there are no findings. */
  readonly highestSeverity?: Severity;
}

export interface ReviewResult {
  /** Identifies exactly what was reviewed, so a stale result can be recognised. */
  readonly pullRequest: {
    readonly number: number;
    readonly baseSha: string;
    readonly headSha: string;
  };
  /** Validated findings that meet the reporting thresholds, deduplicated and ordered by severity. */
  readonly findings: readonly ReviewFinding[];
  /** Findings that were left out because they fell below the reporting thresholds. */
  readonly suppressedFindingCount: number;
  /** One entry per registered rule, in registration order. */
  readonly rules: readonly RuleExecution[];
  readonly diagnostics: readonly Diagnostic[];
  readonly summary: ReviewSummary;
}

export function summarizeFindings(findings: readonly ReviewFinding[]): ReviewSummary {
  const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<
    Severity,
    number
  >;
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
  }

  const highest = highestSeverity(findings.map((finding) => finding.severity));
  return {
    total: findings.length,
    bySeverity,
    ...(highest === undefined ? {} : { highestSeverity: highest }),
  };
}
