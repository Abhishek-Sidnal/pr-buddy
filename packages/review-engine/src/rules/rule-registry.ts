import { z } from "zod";
import { RuleDefinitionError } from "../errors.js";
import { ruleIdSchema } from "../findings/rule-id.js";
import { severitySchema } from "../findings/severity.js";
import { MAX_RULE_DESCRIPTION_LENGTH } from "../limits.js";
import { formatZodIssues } from "../utils/zod-issues.js";
import type { ReviewRule } from "./rule.js";

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

function isSchemaLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    isFunction(value.safeParse)
  );
}

const ruleDefinitionSchema = z.object({
  id: ruleIdSchema,
  version: z
    .string()
    .regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/, "must be a semantic version, for example 1.0.0"),
  description: z.string().trim().min(1).max(MAX_RULE_DESCRIPTION_LENGTH),
  defaultSeverity: severitySchema,
  optionsSchema: z.custom(isSchemaLike, "must be a Zod schema"),
  run: z.custom(isFunction, "must be a function"),
});

/** The set of rules an engine can run, in registration order. */
export class RuleRegistry {
  readonly #rules = new Map<string, ReviewRule>();

  constructor(rules: Iterable<ReviewRule> = []) {
    for (const rule of rules) {
      this.register(rule);
    }
  }

  /**
   * Adds a rule.
   * @throws {RuleDefinitionError} if the definition is invalid or the ID is already registered.
   */
  register(rule: ReviewRule): this {
    const parsed = ruleDefinitionSchema.safeParse(rule);
    if (!parsed.success) {
      throw new RuleDefinitionError("Invalid rule definition.", formatZodIssues(parsed.error));
    }
    if (this.#rules.has(rule.id)) {
      throw new RuleDefinitionError(`A rule with the ID "${rule.id}" is already registered.`);
    }
    this.#rules.set(rule.id, rule);
    return this;
  }

  has(ruleId: string): boolean {
    return this.#rules.has(ruleId);
  }

  get(ruleId: string): ReviewRule | undefined {
    return this.#rules.get(ruleId);
  }

  list(): readonly ReviewRule[] {
    return [...this.#rules.values()];
  }
}
