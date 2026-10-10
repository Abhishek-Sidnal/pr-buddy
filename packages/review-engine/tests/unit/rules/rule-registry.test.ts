import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RuleDefinitionError } from "../../../src/errors.js";
import { builtinRules, createBuiltinRegistry } from "../../../src/rules/builtin.js";
import { RuleRegistry } from "../../../src/rules/rule-registry.js";
import { defineRule, type ReviewRule } from "../../../src/rules/rule.js";

function buildRule(overrides: Partial<ReviewRule> = {}): ReviewRule {
  return {
    id: "example-rule",
    version: "1.0.0",
    description: "An example rule.",
    defaultSeverity: "low",
    optionsSchema: z.strictObject({}),
    run: () => [],
    ...overrides,
  };
}

describe("RuleRegistry", () => {
  it("registers rules and lists them in registration order", () => {
    const first = buildRule({ id: "first-rule" });
    const second = buildRule({ id: "second-rule" });

    const registry = new RuleRegistry().register(first).register(second);

    expect(registry.list()).toEqual([first, second]);
    expect(registry.has("first-rule")).toBe(true);
    expect(registry.get("second-rule")).toBe(second);
  });

  it("accepts rules through the constructor", () => {
    const registry = new RuleRegistry([buildRule()]);

    expect(registry.list()).toHaveLength(1);
  });

  it("reports unknown rules as absent", () => {
    const registry = new RuleRegistry();

    expect(registry.has("missing-rule")).toBe(false);
    expect(registry.get("missing-rule")).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("returns a copy from list so callers cannot alter the registry", () => {
    const registry = new RuleRegistry([buildRule()]);

    (registry.list() as ReviewRule[]).pop();

    expect(registry.list()).toHaveLength(1);
  });

  it("rejects a duplicate rule ID", () => {
    const registry = new RuleRegistry([buildRule()]);

    expect(() => registry.register(buildRule())).toThrow(
      new RuleDefinitionError('A rule with the ID "example-rule" is already registered.'),
    );
  });

  it.each([
    ["an ID that is not kebab-case", { id: "Example_Rule" }, "id:"],
    ["an empty ID", { id: "" }, "id:"],
    ["a version that is not semantic", { version: "v1" }, "version:"],
    ["a blank description", { description: "   " }, "description:"],
    ["an unknown default severity", { defaultSeverity: "urgent" }, "defaultSeverity:"],
    ["an options schema that is not a schema", { optionsSchema: {} }, "optionsSchema:"],
    ["a missing options schema", { optionsSchema: undefined }, "optionsSchema:"],
    ["a run property that is not a function", { run: "run" }, "run:"],
  ])("rejects a rule with %s", (_name, overrides, expectedIssue) => {
    const rule = { ...buildRule(), ...overrides } as unknown as ReviewRule;

    const register = (): RuleRegistry => new RuleRegistry().register(rule);

    expect(register).toThrow(RuleDefinitionError);
    expect(register).toThrow(expectedIssue);
  });
});

describe("built-in rules", () => {
  it("are all registered under unique IDs", () => {
    const registry = createBuiltinRegistry();

    expect(registry.list().map((rule) => rule.id)).toEqual([
      "pr-description",
      "max-changed-files",
      "max-changed-lines",
      "missing-test-changes",
      "debug-statements",
      "credential-files",
      "sensitive-file-changes",
    ]);
  });

  it("each declare an identifier, version, description, severity and options schema", () => {
    for (const rule of builtinRules) {
      expect(rule.id).toMatch(/^[a-z-]+$/);
      expect(rule.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(rule.description.length).toBeGreaterThan(20);
      expect(["low", "medium", "high", "critical"]).toContain(rule.defaultSeverity);
      expect(rule.optionsSchema.safeParse({}).success).toBe(true);
    }
  });

  it("gives every caller its own registry", () => {
    const registry = createBuiltinRegistry().register(buildRule());

    expect(registry.list()).toHaveLength(builtinRules.length + 1);
    expect(createBuiltinRegistry().list()).toHaveLength(builtinRules.length);
  });
});

describe("defineRule", () => {
  it("returns a frozen rule", () => {
    const rule = defineRule(buildRule());

    expect(Object.isFrozen(rule)).toBe(true);
  });
});
