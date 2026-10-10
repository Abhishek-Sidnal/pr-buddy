import { z } from "zod";

/** Ordered from least to most severe. */
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Negative when `a` is less severe than `b`, positive when more severe, zero when equal. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

export function highestSeverity(severities: readonly Severity[]): Severity | undefined {
  return severities.reduce<Severity | undefined>(
    (highest, severity) =>
      highest === undefined || compareSeverity(severity, highest) > 0 ? severity : highest,
    undefined,
  );
}
