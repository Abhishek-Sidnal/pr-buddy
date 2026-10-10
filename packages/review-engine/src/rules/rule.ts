import type { z } from "zod";
import type { ReviewContext } from "../context/context.schema.js";
import type { RuleFindingDraft } from "../findings/finding.schema.js";
import type { Severity } from "../findings/severity.js";

export type RuleOutput = readonly RuleFindingDraft[];

/**
 * A deterministic check. `run` must be a pure function of its arguments: no I/O, no shared
 * state, and nothing from the reviewed repository is ever executed.
 */
export interface ReviewRule<TOptionsSchema extends z.ZodType = z.ZodType> {
  /** Unique kebab-case identifier. Never reuse an ID for different behaviour. */
  readonly id: string;
  /** Semantic version of the rule's behaviour, recorded with every review. */
  readonly version: string;
  readonly description: string;
  /** Used when neither the configuration nor the finding sets a severity. */
  readonly defaultSeverity: Severity;
  /** Validates the rule's options. Must accept `{}` if the rule works without configuration. */
  readonly optionsSchema: TOptionsSchema;
  run(context: ReviewContext, options: z.output<TOptionsSchema>): RuleOutput | Promise<RuleOutput>;
}

/** Declares a rule and infers the type of `options` from `optionsSchema`. */
export function defineRule<TOptionsSchema extends z.ZodType>(
  rule: ReviewRule<TOptionsSchema>,
): ReviewRule<TOptionsSchema> {
  return Object.freeze(rule);
}
