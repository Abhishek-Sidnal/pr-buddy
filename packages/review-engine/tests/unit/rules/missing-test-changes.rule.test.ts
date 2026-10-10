import { describe, expect, it } from "vitest";
import { MAX_EVIDENCE_VALUE_LENGTH, MAX_GLOB_PATTERNS } from "../../../src/limits.js";
import { missingTestChangesRule } from "../../../src/rules/missing-test-changes.rule.js";
import {
  buildContext,
  buildFile,
  buildFiles,
  runRuleWith,
  type FileInput,
} from "../../helpers/builders.js";

const run = (files: FileInput[], options?: unknown): ReturnType<typeof runRuleWith> =>
  runRuleWith(missingTestChangesRule, buildContext({ files }), options);

const source = (path = "src/services/user.service.ts"): FileInput => buildFile({ path });

describe("missing-test-changes", () => {
  it("reports source edits that come with no test edits", async () => {
    const findings = await run([source()]);

    expect(findings).toEqual([
      {
        confidence: 0.6,
        message:
          "The pull request edits 1 source file but no test files. " +
          "This is a signal, not proof: existing tests may already cover the change.",
        evidence: [
          { label: "Edited source files", value: "src/services/user.service.ts" },
          {
            label: "Test file patterns checked",
            value: expect.stringContaining("**/__tests__/**") as string,
          },
        ],
        suggestion: expect.stringContaining("no action is needed") as string,
      },
    ]);
  });

  it("never claims that tests are missing", async () => {
    const [finding] = await run([source()]);

    expect(finding?.message).toContain("not proof");
    expect(finding?.message).not.toMatch(/no tests|untested|lacks tests|missing tests/i);
    expect(finding?.confidence).toBeLessThan(1);
  });

  it.each([
    "src/services/user.service.test.ts",
    "src/services/user.service.spec.tsx",
    "src/services/__tests__/user.service.ts",
    "tests/services/user.service.ts",
    "test/user.js",
    "e2e/login.mjs",
    "user.test.js",
  ])("reports nothing when %s is edited too", async (testPath) => {
    await expect(run([source(), buildFile({ path: testPath })])).resolves.toEqual([]);
  });

  it.each([
    ["documentation", "docs/guide.md"],
    ["a stylesheet", "src/app.css"],
    ["a JSON file", "package.json"],
    ["a type declaration", "src/types/api.d.ts"],
    ["a tool configuration file", "vitest.config.ts"],
    ["a nested configuration file", "apps/web/vite.config.mts"],
    ["a story file", "src/Button.stories.tsx"],
  ])("reports nothing when only %s is edited", async (_name, path) => {
    await expect(run([buildFile({ path })])).resolves.toEqual([]);
  });

  it("reports nothing for an empty diff", async () => {
    await expect(run([])).resolves.toEqual([]);
  });

  it("reports nothing when source files are only removed", async () => {
    const files = [
      buildFile({ path: "src/legacy.ts", status: "removed", additions: 0, deletions: 40 }),
    ];

    await expect(run(files)).resolves.toEqual([]);
  });

  it("reports nothing for a pure rename", async () => {
    const files = [
      buildFile({
        path: "src/shared/date.ts",
        previousPath: "src/utils/date.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
      }),
    ];

    await expect(run(files)).resolves.toEqual([]);
  });

  it("reports a renamed file whose content was edited", async () => {
    const files = [
      buildFile({
        path: "src/shared/date.ts",
        previousPath: "src/utils/date.ts",
        status: "renamed",
      }),
    ];

    const findings = await run(files);

    expect(findings[0]?.evidence[0]?.value).toBe("src/shared/date.ts");
  });

  it("does not treat a removed test file as a test edit", async () => {
    const files = [
      source(),
      buildFile({
        path: "src/services/user.service.test.ts",
        status: "removed",
        additions: 0,
        deletions: 20,
      }),
    ];

    await expect(run(files)).resolves.toHaveLength(1);
  });

  it("recognises every JavaScript and TypeScript extension as source", async () => {
    const paths = ["a.js", "b.jsx", "c.mjs", "d.cjs", "e.ts", "f.tsx", "g.mts", "h.cts"];

    const findings = await run(paths.map((path) => buildFile({ path: `src/${path}` })));

    expect(findings[0]?.message).toContain("8 source files");
  });

  it("lists at most five files and says how many were left out", async () => {
    const findings = await run(buildFiles(8));

    expect(findings[0]?.evidence[0]?.value).toBe(
      "src/file-0.ts, src/file-1.ts, src/file-2.ts, src/file-3.ts, src/file-4.ts (and 3 more)",
    );
  });

  it("keeps evidence within the size limit for very long paths", async () => {
    const files = Array.from({ length: 5 }, (_unused, index) =>
      buildFile({ path: `src/${"deep/".repeat(190)}file-${index}.ts` }),
    );

    const findings = await run(files);

    expect(findings[0]?.evidence[0]?.value.length).toBeLessThanOrEqual(MAX_EVIDENCE_VALUE_LENGTH);
  });

  it("honours the repository's own conventions", async () => {
    const options = {
      sourcePatterns: ["lib/**/*.py"],
      testPatterns: ["spec/**"],
      ignorePatterns: ["lib/generated/**"],
    };

    await expect(run([buildFile({ path: "lib/app.py" })], options)).resolves.toHaveLength(1);
    await expect(run([source()], options)).resolves.toEqual([]);
    await expect(run([buildFile({ path: "lib/generated/api.py" })], options)).resolves.toEqual([]);
    await expect(
      run([buildFile({ path: "lib/app.py" }), buildFile({ path: "spec/app_spec.py" })], options),
    ).resolves.toEqual([]);
  });

  it("never reports a file or line", async () => {
    const [finding] = await run([source()]);

    expect(finding).not.toHaveProperty("filePath");
    expect(finding).not.toHaveProperty("line");
  });

  it.each([
    ["no test patterns", { testPatterns: [] }],
    ["no source patterns", { sourcePatterns: [] }],
    [
      "too many patterns",
      { testPatterns: Array.from({ length: MAX_GLOB_PATTERNS + 1 }, () => "**/*.ts") },
    ],
    ["a non-string pattern", { testPatterns: [42] }],
    ["patterns that are not a list", { ignorePatterns: "**/*.d.ts" }],
    ["an unknown option", { tests: ["**/*.test.ts"] }],
  ])("rejects options with %s", (_name, options) => {
    expect(missingTestChangesRule.optionsSchema.safeParse(options).success).toBe(false);
  });

  it("accepts an empty ignore list", () => {
    expect(missingTestChangesRule.optionsSchema.safeParse({ ignorePatterns: [] }).success).toBe(
      true,
    );
  });
});
