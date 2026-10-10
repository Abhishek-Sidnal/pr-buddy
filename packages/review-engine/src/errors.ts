export type ErrorCode = "INVALID_CONFIGURATION" | "INVALID_CONTEXT" | "INVALID_RULE";

/**
 * Base class for errors thrown across the public API. `issues` lists each problem as
 * "<field>: <constraint>"; input values are never included.
 */
export class PrBuddyError extends Error {
  readonly code: ErrorCode;
  readonly issues: readonly string[];

  constructor(code: ErrorCode, summary: string, issues: readonly string[] = []) {
    super([summary, ...issues.map((issue) => `  - ${issue}`)].join("\n"));
    this.name = new.target.name;
    this.code = code;
    this.issues = Object.freeze([...issues]);
  }
}

export class ConfigurationError extends PrBuddyError {
  constructor(issues: readonly string[]) {
    super("INVALID_CONFIGURATION", "Invalid PR Buddy configuration.", issues);
  }
}

export class InvalidContextError extends PrBuddyError {
  constructor(issues: readonly string[]) {
    super("INVALID_CONTEXT", "Invalid review context.", issues);
  }
}

export class RuleDefinitionError extends PrBuddyError {
  constructor(summary: string, issues: readonly string[] = []) {
    super("INVALID_RULE", summary, issues);
  }
}
