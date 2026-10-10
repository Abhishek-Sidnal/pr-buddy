import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConfigurationError,
  createBuiltinRegistry,
  builtinRules,
  createReviewEngine,
  defineRule,
  InvalidContextError,
  RuleRegistry,
  type ReviewContext,
  type ReviewEngine,
  type ReviewResult,
  type ReviewRule,
  type RuleOutput,
} from "../../../src/index.js";
import { MAX_FINDINGS_PER_RULE, MAX_RULE_TIMEOUT_MS } from "../../../src/limits.js";
import { BASE_SHA, buildContext, buildFile, buildFiles, HEAD_SHA } from "../../helpers/builders.js";

const evidence = [{ label: "Reason", value: "Because" }];

/** Declares a test rule that takes no options. */
function testRule(
  id: string,
  run: (context: ReviewContext) => RuleOutput | Promise<RuleOutput>,
  overrides: Partial<ReviewRule> = {},
): ReviewRule {
  return defineRule({
    id,
    version: "1.0.0",
    description: `Test rule ${id}.`,
    defaultSeverity: "low",
    optionsSchema: z.strictObject({}),
    run,
    ...overrides,
  });
}

function engineWith(
  rules: ReviewRule[],
  options: { config?: unknown; ruleTimeoutMs?: number } = {},
): ReviewEngine {
  return createReviewEngine({ registry: new RuleRegistry(rules), ...options });
}

/** Returns something a correctly typed rule never could, as a faulty plugin might. */
const misbehave = (value: unknown): RuleOutput => value as RuleOutput;

describe("createReviewEngine", () => {
  it("uses the built-in rules by default", () => {
    expect(createReviewEngine().rules).toEqual([
      expect.objectContaining({ id: "pr-description", enabled: true, severity: "low" }),
      expect.objectContaining({ id: "max-changed-files", enabled: true, severity: "medium" }),
      expect.objectContaining({ id: "max-changed-lines", enabled: true, severity: "medium" }),
      expect.objectContaining({ id: "missing-test-changes", enabled: true, severity: "low" }),
      expect.objectContaining({ id: "debug-statements", enabled: true, severity: "low" }),
      expect.objectContaining({ id: "credential-files", enabled: true, severity: "high" }),
      expect.objectContaining({ id: "sensitive-file-changes", enabled: true, severity: "medium" }),
    ]);
  });

  it("describes how each rule is configured", () => {
    const engine = createReviewEngine({
      config: { rules: { "pr-description": { enabled: false, severity: "high" } } },
    });

    expect(engine.rules[0]).toEqual({
      id: "pr-description",
      version: "1.0.0",
      description: expect.any(String) as string,
      enabled: false,
      severity: "high",
    });
  });

  it("rejects invalid configuration before any review", () => {
    expect(() => createReviewEngine({ config: { rules: { "no-such-rule": {} } } })).toThrow(
      ConfigurationError,
    );
  });

  it.each([0, -1, 1.5, MAX_RULE_TIMEOUT_MS + 1, Number.NaN])(
    "rejects a rule time limit of %s",
    (ruleTimeoutMs) => {
      expect(() => createReviewEngine({ ruleTimeoutMs })).toThrow(ConfigurationError);
    },
  );
});

describe("review", () => {
  it("returns no findings for a pull request that satisfies every rule", async () => {
    const files = [buildFile({ path: "src/a.ts" }), buildFile({ path: "src/a.test.ts" })];

    const result = await createReviewEngine().review(buildContext({ files }));

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toEqual({
      total: 0,
      bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
    });
    expect(result.rules.map((rule) => rule.status)).toEqual(builtinRules.map(() => "completed"));
    expect(result.suppressedFindingCount).toBe(0);
  });

  it("identifies the commit that was reviewed", async () => {
    const result = await createReviewEngine().review(buildContext({ pullRequest: { number: 42 } }));

    expect(result.pullRequest).toEqual({ number: 42, baseSha: BASE_SHA, headSha: HEAD_SHA });
  });

  it("reports findings from every built-in rule, ordered by severity", async () => {
    const context = buildContext({ pullRequest: { body: null }, files: buildFiles(31) });

    const result = await createReviewEngine().review(context);

    expect(result.findings.map((finding) => [finding.ruleId, finding.severity])).toEqual([
      ["max-changed-files", "medium"],
      ["missing-test-changes", "low"],
      ["pr-description", "low"],
    ]);
    expect(result.summary).toEqual({
      total: 3,
      bySeverity: { low: 2, medium: 1, high: 0, critical: 0 },
      highestSeverity: "medium",
    });
  });

  it("stamps the rule ID, default severity and full confidence on findings", async () => {
    const engine = engineWith([testRule("stamp-rule", () => [{ message: "Hello.", evidence }])]);

    const result = await engine.review(buildContext());

    expect(result.findings).toEqual([
      { ruleId: "stamp-rule", severity: "low", confidence: 1, message: "Hello.", evidence },
    ]);
  });

  it("keeps the severity and confidence a rule chooses for a finding", async () => {
    const engine = engineWith([
      testRule("graded-rule", () => [
        { message: "Graded.", evidence, severity: "critical", confidence: 0.4 },
      ]),
    ]);

    const result = await engine.review(buildContext());

    expect(result.findings[0]).toMatchObject({ severity: "critical", confidence: 0.4 });
  });

  it("lets configuration override every severity a rule reports", async () => {
    const rule = testRule("graded-rule", () => [
      { message: "First.", evidence, severity: "critical" },
      { message: "Second.", evidence },
    ]);
    const engine = engineWith([rule], {
      config: { rules: { "graded-rule": { severity: "medium" } } },
    });

    const result = await engine.review(buildContext());

    expect(result.findings.map((finding) => finding.severity)).toEqual(["medium", "medium"]);
  });

  it("does not run a disabled rule", async () => {
    let calls = 0;
    const rule = testRule("counted-rule", () => {
      calls += 1;
      return [{ message: "Ran.", evidence }];
    });
    const engine = engineWith([rule], {
      config: { rules: { "counted-rule": { enabled: false } } },
    });

    const result = await engine.review(buildContext());

    expect(calls).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.rules).toEqual([
      {
        ruleId: "counted-rule",
        ruleVersion: "1.0.0",
        status: "disabled",
        findingCount: 0,
        durationMs: 0,
      },
    ]);
  });

  it("passes validated options to the rule", async () => {
    const rule = defineRule({
      id: "option-rule",
      version: "1.0.0",
      description: "Echoes an option.",
      defaultSeverity: "low",
      optionsSchema: z.strictObject({ word: z.string().default("default") }),
      run: (_context, options) => [{ message: options.word, evidence }],
    });

    const byDefault = await engineWith([rule]).review(buildContext());
    const configured = await engineWith([rule], {
      config: { rules: { "option-rule": { options: { word: "configured" } } } },
    }).review(buildContext());

    expect(byDefault.findings[0]?.message).toBe("default");
    expect(configured.findings[0]?.message).toBe("configured");
  });

  it("supports asynchronous rules", async () => {
    const engine = engineWith([
      testRule("async-rule", async () => {
        await Promise.resolve();
        return [{ message: "Async.", evidence }];
      }),
    ]);

    const result = await engine.review(buildContext());

    expect(result.findings).toHaveLength(1);
  });

  it("gives rules a frozen context", async () => {
    const engine = engineWith([
      testRule("mutating-rule", (context) => {
        (context.files as unknown[]).push("injected");
        return [];
      }),
      testRule("observing-rule", (context) => [
        { message: `Saw ${context.files.length} files.`, evidence },
      ]),
    ]);

    const result = await engine.review(buildContext());

    expect(result.rules[0]?.status).toBe("failed");
    expect(result.findings[0]?.message).toBe("Saw 1 files.");
  });

  it("is deterministic", async () => {
    const context = buildContext({ pullRequest: { body: null }, files: buildFiles(40) });
    const engine = createReviewEngine();

    const [first, second] = await Promise.all([engine.review(context), engine.review(context)]);

    expect(first.findings).toEqual(second.findings);
  });

  it("can review many pull requests with one engine", async () => {
    const engine = createReviewEngine();

    const noisy = await engine.review(buildContext({ pullRequest: { body: null } }));
    const quiet = await engine.review(buildContext({ files: [] }));

    expect(noisy.findings.length).toBeGreaterThan(0);
    expect(quiet.findings).toEqual([]);
  });
});

describe("review input validation", () => {
  it.each([
    ["null", null],
    ["a string", "context"],
    ["a context without files", { pullRequest: buildContext().pullRequest }],
    ["a file with path traversal", buildContext({ files: [buildFile({ path: "../x.ts" })] })],
  ])("rejects %s with InvalidContextError", async (_name, input) => {
    await expect(createReviewEngine().review(input)).rejects.toBeInstanceOf(InvalidContextError);
  });

  it("runs no rule when the input is invalid", async () => {
    let calls = 0;
    const engine = engineWith([
      testRule("counted-rule", () => {
        calls += 1;
        return [];
      }),
    ]);

    await expect(engine.review({})).rejects.toBeInstanceOf(InvalidContextError);
    expect(calls).toBe(0);
  });
});

describe("rule isolation", () => {
  const healthy = testRule("healthy-rule", () => [{ message: "Still reported.", evidence }]);

  it("records a rule that throws and still reports the others", async () => {
    const broken = testRule("broken-rule", () => {
      throw new Error("Unexpected failure");
    });

    const result = await engineWith([broken, healthy]).review(buildContext());

    expect(result.rules[0]).toMatchObject({
      ruleId: "broken-rule",
      status: "failed",
      findingCount: 0,
      error: "Unexpected failure",
    });
    expect(result.rules[1]).toMatchObject({
      ruleId: "healthy-rule",
      status: "completed",
      findingCount: 1,
    });
    expect(result.findings.map((finding) => finding.message)).toEqual(["Still reported."]);
  });

  it("records a rule whose promise rejects", async () => {
    const broken = testRule("broken-rule", () => Promise.reject(new Error("Rejected")));

    const result = await engineWith([broken, healthy]).review(buildContext());

    expect(result.rules[0]).toMatchObject({ status: "failed", error: "Rejected" });
    expect(result.findings).toHaveLength(1);
  });

  it("describes a failure that is not an Error", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the engine must survive this
    const broken = testRule("broken-rule", () => Promise.reject("just a string"));

    const result = await engineWith([broken]).review(buildContext());

    expect(result.rules[0]?.error).toBe("The rule threw a value that is not an Error.");
  });

  it("truncates a very long error message", async () => {
    const broken = testRule("broken-rule", () => {
      throw new Error("x".repeat(10_000));
    });

    const result = await engineWith([broken]).review(buildContext());

    expect(result.rules[0]?.error?.length).toBeLessThanOrEqual(500);
  });

  it("stops waiting for a rule that exceeds the time limit", async () => {
    const stuck = testRule("stuck-rule", () => new Promise<RuleOutput>(() => undefined));

    const result = await engineWith([stuck, healthy], { ruleTimeoutMs: 20 }).review(buildContext());

    expect(result.rules[0]).toMatchObject({ status: "failed", error: "Timed out after 20 ms." });
    expect(result.findings).toHaveLength(1);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "finding"],
    ["an object", { message: "Not in an array.", evidence }],
  ])("records a rule that returns %s instead of an array", async (_name, output) => {
    const broken = testRule("broken-rule", () => misbehave(output));

    const result = await engineWith([broken, healthy]).review(buildContext());

    expect(result.rules[0]).toMatchObject({
      status: "failed",
      error: "The rule did not return an array of findings.",
    });
    expect(result.findings).toHaveLength(1);
  });
});

describe("finding validation", () => {
  it("drops malformed findings and keeps valid ones from the same rule", async () => {
    const rule = testRule("sloppy-rule", () =>
      misbehave([
        { message: "Valid.", evidence },
        { message: "No evidence." },
        null,
        "a string",
        { message: "", evidence },
        { message: "Spoofed.", evidence, ruleId: "pr-description" },
      ]),
    );

    const result = await engineWith([rule]).review(buildContext());

    expect(result.findings.map((finding) => finding.message)).toEqual(["Valid."]);
    expect(result.rules[0]).toMatchObject({ status: "completed", findingCount: 1 });
    expect(result.diagnostics).toHaveLength(5);
    expect(result.diagnostics.every((entry) => entry.code === "FINDING_REJECTED")).toBe(true);
    expect(result.diagnostics[0]).toMatchObject({
      ruleId: "sloppy-rule",
      message: expect.stringMatching(/^Finding 1 was rejected: evidence: /) as string,
    });
  });

  it("does not let a rule report under another rule's ID", async () => {
    const impostor = testRule("impostor-rule", () =>
      misbehave([{ message: "Spoofed.", evidence, ruleId: "pr-description" }]),
    );

    const result = await engineWith([impostor]).review(buildContext());

    expect(result.findings).toEqual([]);
  });

  it("keeps only the first findings of a rule that returns too many", async () => {
    const flood = testRule("flood-rule", () =>
      Array.from({ length: MAX_FINDINGS_PER_RULE + 25 }, (_unused, index) => ({
        message: `Finding ${index}.`,
        evidence,
      })),
    );

    const result = await engineWith([flood]).review(buildContext());

    expect(result.findings).toHaveLength(MAX_FINDINGS_PER_RULE);
    expect(result.diagnostics).toEqual([
      {
        ruleId: "flood-rule",
        code: "FINDINGS_TRUNCATED",
        message: "The rule returned 125 findings; only the first 100 were kept.",
      },
    ]);
  });

  it("merges identical findings", async () => {
    const rule = testRule("repeating-rule", () => [
      { message: "Same.", evidence },
      { message: "Same.", evidence },
    ]);

    const result = await engineWith([rule]).review(buildContext());

    expect(result.findings).toHaveLength(1);
    expect(result.summary.total).toBe(1);
  });
});

describe("location validation", () => {
  const files = [
    buildFile({
      path: "src/edited.ts",
      additions: 1,
      deletions: 1,
      patch: "@@ -10,3 +10,3 @@\n ten\n-eleven\n+ELEVEN\n twelve",
    }),
  ];

  const locate = (location: { filePath?: string; line?: number }): Promise<ReviewResult> =>
    engineWith([
      testRule("locating-rule", () => [{ message: "Here.", evidence, ...location }]),
    ]).review(buildContext({ files }));

  it("keeps a location that exists in the diff", async () => {
    const result = await locate({ filePath: "src/edited.ts", line: 11 });

    expect(result.findings[0]).toMatchObject({ filePath: "src/edited.ts", line: 11 });
    expect(result.diagnostics).toEqual([]);
  });

  it("removes an invented line and says so", async () => {
    const result = await locate({ filePath: "src/edited.ts", line: 500 });

    expect(result.findings[0]).toMatchObject({ filePath: "src/edited.ts" });
    expect(result.findings[0]).not.toHaveProperty("line");
    expect(result.diagnostics).toEqual([
      {
        ruleId: "locating-rule",
        code: "LOCATION_REMOVED",
        message:
          'Finding 0 lost its location: line 500 of "src/edited.ts" is not part of the diff.',
      },
    ]);
  });

  it("removes an invented file but keeps the finding", async () => {
    const result = await locate({ filePath: "src/never-changed.ts", line: 1 });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).not.toHaveProperty("filePath");
    expect(result.findings[0]).not.toHaveProperty("line");
    expect(result.diagnostics[0]?.code).toBe("LOCATION_REMOVED");
  });

  it("orders located findings by file and line", async () => {
    const rule = testRule("locating-rule", () => [
      { message: "Third.", evidence, filePath: "src/edited.ts", line: 12 },
      { message: "Second.", evidence, filePath: "src/edited.ts", line: 10 },
      { message: "First.", evidence },
    ]);

    const result = await engineWith([rule]).review(buildContext({ files }));

    expect(result.findings.map((finding) => finding.message)).toEqual([
      "First.",
      "Second.",
      "Third.",
    ]);
  });
});

describe("custom rules", () => {
  it("run alongside the built-in rules", async () => {
    const registry = createBuiltinRegistry().register(
      testRule(
        "no-env-files",
        (context) =>
          context.files
            .filter((file) => file.path.endsWith(".env"))
            .map((file) => ({
              message: "An environment file is part of the pull request.",
              evidence: [{ label: "File", value: file.path }],
              filePath: file.path,
            })),
        { defaultSeverity: "high" },
      ),
    );
    const files = [buildFile({ path: "config/production.env", status: "added" })];

    const result = await createReviewEngine({ registry }).review(buildContext({ files }));

    expect(result.findings).toEqual([
      expect.objectContaining({
        ruleId: "no-env-files",
        severity: "high",
        filePath: "config/production.env",
      }),
    ]);
    expect(result.rules).toHaveLength(builtinRules.length + 1);
  });
});
