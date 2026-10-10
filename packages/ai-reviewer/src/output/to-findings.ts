import {
  createLocationValidator,
  dedupeFindings,
  findingSchema,
  sortFindings,
  type ChangedFile,
  type ReviewFinding,
  type Severity,
} from "@pr-buddy/review-engine";
import { MAX_AI_MESSAGE_LENGTH, MAX_AI_SUGGESTION_LENGTH } from "../limits.js";
import type { Suggestion } from "./parse-response.js";

/** The rule ID every AI suggestion is reported under. */
export const AI_RULE_ID = "ai-review";
/**
 * The confidence of every AI suggestion. A model's own estimate of its certainty is not
 * evidence, so it is not asked for and would not be used.
 */
export const AI_CONFIDENCE = 0.5;
const AI_EVIDENCE = [{ label: "Basis", value: "AI model suggestion, not verified" }];

/** A suggestion is advice to check; it cannot raise the highest alarm on its own. */
function capSeverity(severity: Suggestion["severity"]): Severity {
  return severity === "critical" ? "high" : severity;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function toCandidate(suggestion: Suggestion): unknown {
  const advice = clean(suggestion.suggestion ?? "");
  return {
    ruleId: AI_RULE_ID,
    severity: capSeverity(suggestion.severity),
    confidence: AI_CONFIDENCE,
    message: clean(suggestion.message),
    evidence: AI_EVIDENCE,
    ...(typeof suggestion.filePath === "string" ? { filePath: suggestion.filePath } : {}),
    ...(typeof suggestion.line === "number" ? { line: suggestion.line } : {}),
    ...(advice === "" ? {} : { suggestion: advice }),
  };
}

export interface VerifiedFindings {
  readonly findings: readonly ReviewFinding[];
  /** Suggestions dropped: too long, malformed, repeated, or pointing at a place not sent. */
  readonly rejectedCount: number;
}

/**
 * Turns suggestions into findings and keeps only those that hold up. A suggestion that names a
 * file or line the model was not given is dropped whole: rules lose only their location, but a
 * model that cites something that does not exist is likely wrong about the rest as well.
 */
export function toFindings(
  suggestions: readonly Suggestion[],
  sentFiles: readonly ChangedFile[],
): VerifiedFindings {
  const validateLocation = createLocationValidator(sentFiles);
  const verified: ReviewFinding[] = [];

  for (const suggestion of suggestions) {
    const candidate = findingSchema.safeParse(toCandidate(suggestion));
    if (
      !candidate.success ||
      candidate.data.message.length > MAX_AI_MESSAGE_LENGTH ||
      (candidate.data.suggestion?.length ?? 0) > MAX_AI_SUGGESTION_LENGTH
    ) {
      continue;
    }
    if (validateLocation(candidate.data).removalReason === undefined) {
      verified.push(candidate.data);
    }
  }

  const findings = sortFindings(dedupeFindings(verified));
  return { findings, rejectedCount: suggestions.length - findings.length };
}
