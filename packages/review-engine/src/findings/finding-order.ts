import type { ReviewFinding } from "./finding.schema.js";
import { compareSeverity } from "./severity.js";

/** Locale-independent string comparison, so ordering is the same on every machine. */
function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Orders by severity (highest first), then file, line, rule ID and message. */
export function compareFindings(a: ReviewFinding, b: ReviewFinding): number {
  return (
    compareSeverity(b.severity, a.severity) ||
    compareText(a.filePath ?? "", b.filePath ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    compareText(a.ruleId, b.ruleId) ||
    compareText(a.message, b.message)
  );
}

export function sortFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort(compareFindings);
}

/** Keeps the first of any findings that share rule, location and message. */
export function dedupeFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = JSON.stringify([
      finding.ruleId,
      finding.filePath ?? null,
      finding.line ?? null,
      finding.message,
    ]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
