import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveRules, type ResolvedRule } from "../../../src/config/resolve-config.js";
import { ConfigurationError } from "../../../src/errors.js";
import { createBuiltinRegistry } from "../../../src/rules/builtin.js";
import { RuleRegistry } from "../../../src/rules/rule-registry.js";
import { defineRule } from "../../../src/rules/rule.js";

const registry = createBuiltinRegistry();

function resolved(config: unknown, ruleId: string): ResolvedRule {
  const match = resolveRules(registry, config).find((entry) => entry.rule.id === ruleId);
  if (match === undefined) {
    throw new Error(`Rule ${ruleId} was not resolved.`);
  }
  return match;
}

function issuesOf(config: unknown, rules: RuleRegistry = registry): readonly string[] {
  try {
    resolveRules(rules, config);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("Expected the configuration to be rejected.");
}

describe("resolveRules", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty object", {}],
    ["an empty rules object", { rules: {} }],
  ])("runs every rule with its defaults when the configuration is %s", (_name, config) => {
    const rules = resolveRules(registry, config);

    expect(rules.map((entry) => entry.rule.id)).toEqual([
      "pr-description",
      "max-changed-files",
      "max-changed-lines",
      "missing-test-changes",
      "debug-statements",
      "credential-files",
      "sensitive-file-changes",
    ]);
    expect(rules.every((entry) => entry.enabled)).toBe(true);
    expect(rules.every((entry) => entry.severityOverride === undefined)).toBe(true);
    expect(resolved(config, "pr-description").options).toEqual({ minLength: 30 });
  });

  it("disables a rule", () => {
    const config = { rules: { "pr-description": { enabled: false } } };

    expect(resolved(config, "pr-description").enabled).toBe(false);
    expect(resolved(config, "max-changed-files").enabled).toBe(true);
  });

  it("overrides a rule's severity", () => {
    const config = { rules: { "max-changed-files": { severity: "critical" } } };

    expect(resolved(config, "max-changed-files").severityOverride).toBe("critical");
  });

  it("merges configured options with the rule's defaults", () => {
    const config = { rules: { "max-changed-files": { options: { maxFiles: 5 } } } };

    expect(resolved(config, "max-changed-files").options).toMatchObject({
      maxFiles: 5,
      exclude: expect.arrayContaining(["**/package-lock.json"]) as string[],
    });
  });

  it("freezes resolved options", () => {
    const { options } = resolved({}, "max-changed-files");

    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen((options as { exclude: string[] }).exclude)).toBe(true);
  });

  it("gives each resolution its own copy of default options", () => {
    const first = resolved({}, "max-changed-files").options as { exclude: string[] };
    const second = resolved({}, "max-changed-files").options as { exclude: string[] };

    expect(first.exclude).not.toBe(second.exclude);
  });

  it.each([
    ["a string", "strict"],
    ["a number", 1],
    ["an array", []],
    ["an unknown top-level field", { rule: {} }],
    ["rules that are not an object", { rules: [] }],
    ["rule settings that are not an object", { rules: { "pr-description": true } }],
    ["an unknown rule setting", { rules: { "pr-description": { level: "high" } } }],
    ["a non-boolean enabled flag", { rules: { "pr-description": { enabled: "no" } } }],
    ["an unknown severity", { rules: { "pr-description": { severity: "urgent" } } }],
    ["options that are not an object", { rules: { "pr-description": { options: 5 } } }],
  ])("rejects %s", (_name, config) => {
    expect(() => resolveRules(registry, config)).toThrow(ConfigurationError);
  });

  it("rejects an unknown rule ID and lists the registered rules", () => {
    const issues = issuesOf({ rules: { "max-change-files": { enabled: false } } });

    expect(issues).toEqual([
      "rules.max-change-files: unknown rule. Registered rules: pr-description, max-changed-files, max-changed-lines, missing-test-changes, debug-statements, credential-files, sensitive-file-changes",
    ]);
  });

  it("shortens a very long unknown rule ID before quoting it", () => {
    const issues = issuesOf({ rules: { ["x".repeat(10_000)]: {} } });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.length).toBeLessThan(250);
    expect(issues[0]).toContain("Registered rules: pr-description");
  });

  it("reports invalid rule options with their full path", () => {
    const issues = issuesOf({ rules: { "pr-description": { options: { minLength: 0 } } } });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^rules\.pr-description\.options\.minLength: /);
  });

  it("validates the options of a disabled rule", () => {
    const config = { rules: { "pr-description": { enabled: false, options: { minLength: -1 } } } };

    expect(() => resolveRules(registry, config)).toThrow(ConfigurationError);
  });

  it("collects every problem into one error", () => {
    const issues = issuesOf({
      rules: {
        "no-such-rule": {},
        "pr-description": { options: { minLength: 0 } },
        "max-changed-files": { options: { maxFiles: "many" } },
      },
    });

    expect(issues).toHaveLength(3);
  });

  it("is not confused by prototype property names used as rule IDs", () => {
    const config: unknown = JSON.parse(
      '{"rules":{"__proto__":{"enabled":false},"constructor":{}}}',
    );

    const issues = issuesOf(config);

    expect(issues.every((issue) => issue.includes("unknown rule"))).toBe(true);
    expect(({} as { enabled?: boolean }).enabled).toBeUndefined();
  });

  it("reports a rule that cannot run without options", () => {
    const strictRule = defineRule({
      id: "needs-options",
      version: "1.0.0",
      description: "A rule with a required option.",
      defaultSeverity: "low",
      optionsSchema: z.strictObject({ owner: z.string() }),
      run: () => [],
    });

    const issues = issuesOf({}, new RuleRegistry([strictRule]));

    expect(issues[0]).toMatch(/^rules\.needs-options\.options\.owner: /);
  });

  it("resolves no rules for an empty registry", () => {
    expect(resolveRules(new RuleRegistry(), {})).toEqual([]);
  });
});
