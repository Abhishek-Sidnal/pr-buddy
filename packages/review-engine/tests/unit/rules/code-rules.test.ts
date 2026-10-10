import { describe, expect, it } from "vitest";
import { getAddedLines } from "../../../src/diff/parse-patch.js";
import { credentialFilesRule } from "../../../src/rules/credential-files.rule.js";
import { debugStatementsRule } from "../../../src/rules/debug-statements.rule.js";
import { maxChangedLinesRule } from "../../../src/rules/max-changed-lines.rule.js";
import { sensitiveFileChangesRule } from "../../../src/rules/sensitive-file-changes.rule.js";
import { buildContext, buildFile, runRuleWith, type FileInput } from "../../helpers/builders.js";

/** Builds a patch that adds the given lines to a new file. */
function addingLines(...lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
}

function sourceFile(path: string, ...lines: string[]): FileInput {
  return buildFile({
    path,
    status: "added",
    additions: lines.length,
    deletions: 0,
    patch: addingLines(...lines),
  });
}

describe("getAddedLines", () => {
  it("returns each added line with its number and text", () => {
    const patch = "@@ -3,3 +3,4 @@\n keep\n-old\n+new one\n+new two\n keep";

    expect(getAddedLines(patch)).toEqual([
      { line: 4, text: "new one" },
      { line: 5, text: "new two" },
    ]);
  });

  it("keeps an added empty line and leading whitespace", () => {
    expect(getAddedLines("@@ -0,0 +1,2 @@\n+\n+  indented")).toEqual([
      { line: 1, text: "" },
      { line: 2, text: "  indented" },
    ]);
  });

  it("returns nothing for a hunk that does not match its header", () => {
    expect(getAddedLines("@@ -0,0 +1,5 @@\n+only one line")).toEqual([]);
  });

  it("returns nothing for a deletion", () => {
    expect(getAddedLines("@@ -1,2 +0,0 @@\n-a\n-b")).toEqual([]);
  });
});

describe("max-changed-lines", () => {
  const run = (files: FileInput[], options?: unknown): ReturnType<typeof runRuleWith> =>
    runRuleWith(maxChangedLinesRule, buildContext({ files }), options);
  const edit = (path: string, additions: number, deletions: number): FileInput =>
    buildFile({ path, additions, deletions });

  it("reports nothing at the default limit of 1,000 lines", async () => {
    await expect(run([edit("src/a.ts", 600, 400)])).resolves.toEqual([]);
  });

  it("reports a pull request one line over the limit, counting additions and deletions", async () => {
    await expect(run([edit("src/a.ts", 600, 300), edit("src/b.ts", 100, 1)])).resolves.toEqual([
      {
        message: "The pull request changes 1001 lines, more than the configured maximum of 1000.",
        evidence: [
          { label: "Lines added and removed", value: "1001" },
          { label: "Configured maximum", value: "1000" },
        ],
        suggestion: expect.stringContaining("smaller pull requests") as string,
      },
    ]);
  });

  it("does not count lockfiles by default, and says how many files were left out", async () => {
    const files = [edit("src/a.ts", 1_001, 0), edit("package-lock.json", 9_000, 8_000)];

    const findings = await run(files);

    expect(findings[0]?.evidence).toEqual([
      { label: "Lines added and removed", value: "1001" },
      { label: "Configured maximum", value: "1000" },
      { label: "Files excluded from the count", value: "1" },
    ]);
    await expect(run([edit("package-lock.json", 9_000, 8_000)])).resolves.toEqual([]);
  });

  it("honours a configured limit and exclusions", async () => {
    const files = [edit("src/a.ts", 5, 5), edit("src/generated/api.ts", 500, 0)];

    await expect(run(files, { maxLines: 10, exclude: ["src/generated/**"] })).resolves.toEqual([]);
    await expect(run(files, { maxLines: 10, exclude: [] })).resolves.toHaveLength(1);
  });

  it("reports nothing for an empty diff", async () => {
    await expect(run([])).resolves.toEqual([]);
  });

  it.each([{ maxLines: 0 }, { maxLines: 1.5 }, { maxLines: "many" }, { exclude: "x" }, { max: 5 }])(
    "rejects the options %j",
    (options) => {
      expect(maxChangedLinesRule.optionsSchema.safeParse(options).success).toBe(false);
    },
  );
});

describe("debug-statements", () => {
  const run = (files: FileInput[], options?: unknown): ReturnType<typeof runRuleWith> =>
    runRuleWith(debugStatementsRule, buildContext({ files }), options);

  it("points at each added debugging statement", async () => {
    const file = sourceFile(
      "src/service.ts",
      "export function load() {",
      "  console.log('loading', id);",
      "  debugger;",
      "  return fetchIt();",
      "}",
    );

    await expect(run([file])).resolves.toEqual([
      {
        confidence: 0.9,
        message: "A console.log statement was added.",
        evidence: [{ label: "Statement", value: "console.log" }],
        filePath: "src/service.ts",
        line: 2,
        suggestion: expect.stringContaining("Remove it before merging") as string,
      },
      expect.objectContaining({
        message: "A debugger statement was added.",
        evidence: [{ label: "Statement", value: "debugger" }],
        line: 3,
      }),
    ]);
  });

  it("never quotes the source line", async () => {
    const findings = await run([sourceFile("src/a.ts", "console.log(SECRET_CANARY_VALUE);")]);

    expect(JSON.stringify(findings)).not.toContain("SECRET_CANARY_VALUE");
  });

  it.each(["log", "debug", "trace", "table", "dir"])("reports console.%s", async (method) => {
    const findings = await run([sourceFile("src/a.ts", `  console.${method}(value);`)]);

    expect(findings[0]?.evidence).toEqual([{ label: "Statement", value: `console.${method}` }]);
  });

  it.each([
    ["console.error, which is real error handling", "console.error(error);"],
    ["console.warn", "console.warn('deprecated');"],
    ["a commented-out call", "// console.log(value);"],
    ["a call inside a block comment", " * console.log(value) prints the value"],
    ["a property that only looks similar", "myconsole.log(value);"],
    ["a mention without a call", "const logger = console.log;"],
    ["an identifier containing debugger", "const debuggerEnabled = true;"],
    ["debugger used as a property", "tools.debugger.attach();"],
  ])("does not report %s", async (_name, line) => {
    await expect(run([sourceFile("src/a.ts", line)])).resolves.toEqual([]);
  });

  it.each([
    ["a statement with a trailing comment", "debugger; // remove me"],
    ["a statement without a semicolon", "  debugger"],
    ["a call with space before the parenthesis", "console.log (value)"],
    ["a call in the middle of a line", "if (x) { console.debug(x); }"],
  ])("reports %s", async (_name, line) => {
    await expect(run([sourceFile("src/a.ts", line)])).resolves.toHaveLength(1);
  });

  it("only looks at added lines", async () => {
    const patch =
      "@@ -1,3 +1,3 @@\n console.log('already here');\n-console.log('removed');\n+const x = 1;\n return x;";
    const file = buildFile({ path: "src/a.ts", additions: 1, deletions: 1, patch });

    await expect(run([file])).resolves.toEqual([]);
  });

  it("does not check test files, other languages or files without a patch", async () => {
    const files = [
      sourceFile("src/a.test.ts", "console.log(value);"),
      sourceFile("tests/helper.ts", "console.log(value);"),
      sourceFile("scripts/build.py", "console.log(value);"),
      buildFile({ path: "src/no-patch.ts", status: "added", additions: 5, deletions: 0 }),
    ];

    await expect(run(files)).resolves.toEqual([]);
  });

  it("skips very long lines, which are generated code", async () => {
    const minified = `${"a=1;".repeat(300)}console.log(a);`;

    await expect(run([sourceFile("src/bundle.js", minified)])).resolves.toEqual([]);
  });

  it("handles a hostile line quickly", async () => {
    const hostile = `console.${"log ".repeat(200)}${" ".repeat(150)}`;
    const startedAt = performance.now();

    await run([sourceFile("src/a.ts", hostile)]);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("lists up to the limit one by one and counts the rest", async () => {
    const lines = Array.from({ length: 13 }, (_unused, index) => `console.log(${index});`);

    const findings = await run([sourceFile("src/noisy.ts", ...lines)]);

    expect(findings).toHaveLength(11);
    expect(findings.slice(0, 10).map((finding) => finding.line)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(findings[10]).toEqual({
      confidence: 0.9,
      message: "3 more debugging statements were added and are not listed one by one.",
      evidence: [
        { label: "Listed individually", value: "10" },
        { label: "Not listed", value: "3" },
      ],
    });
  });

  it("uses the singular for one unlisted statement", async () => {
    const lines = ["console.log(1);", "console.log(2);"];

    const findings = await run([sourceFile("src/a.ts", ...lines)], { maxFindings: 1 });

    expect(findings[1]?.message).toBe(
      "1 more debugging statement was added and is not listed one by one.",
    );
  });

  it("honours configured methods, files and exclusions", async () => {
    const files = [
      sourceFile("src/a.ts", "console.info(value);", "console.log(value);"),
      sourceFile("src/cli/print.ts", "console.info(value);"),
    ];

    const findings = await run(files, { consoleMethods: ["info"], exclude: ["src/cli/**"] });

    expect(findings.map((finding) => [finding.filePath, finding.line])).toEqual([["src/a.ts", 1]]);
  });

  it("reports only debugger statements when no console method is configured", async () => {
    const file = sourceFile("src/a.ts", "console.log(value);", "debugger;");

    const findings = await run([file], { consoleMethods: [] });

    expect(findings.map((finding) => finding.line)).toEqual([2]);
  });

  it.each([
    { consoleMethods: ["log|.*"] },
    { consoleMethods: ["lo g"] },
    { consoleMethods: [""] },
    { consoleMethods: "log" },
    { maxFindings: 0 },
    { maxFindings: 51 },
    { unknown: true },
  ])("rejects the options %j", (options) => {
    expect(debugStatementsRule.optionsSchema.safeParse(options).success).toBe(false);
  });
});

describe("credential-files", () => {
  const run = (files: FileInput[], options?: unknown): ReturnType<typeof runRuleWith> =>
    runRuleWith(credentialFilesRule, buildContext({ files }), options);
  const added = (path: string): FileInput => buildFile({ path, status: "added" });

  it("reports a credential file by name and says its contents were not read", async () => {
    await expect(run([added("config/.env")])).resolves.toEqual([
      {
        confidence: 0.8,
        message:
          "A file that usually holds credentials is part of the pull request. Its name was checked, not its contents.",
        evidence: [
          { label: "File", value: "config/.env" },
          { label: "Matched pattern", value: "**/.env" },
        ],
        filePath: "config/.env",
        suggestion: expect.stringContaining("replace the credentials") as string,
      },
    ]);
  });

  it.each([
    ".env",
    ".env.production",
    "apps/web/.env.local",
    "deploy/server.pem",
    "certs/private.key",
    "release/upload.keystore",
    "id_rsa",
    ".ssh/id_ed25519",
    ".netrc",
    "store/cert.p12",
  ])("reports %s", async (path) => {
    await expect(run([added(path)])).resolves.toHaveLength(1);
  });

  it.each([
    ".env.example",
    "apps/web/.env.sample",
    ".env.template",
    "src/environment.ts",
    "docs/keys.md",
    "src/id_rsa.ts",
    "public/key.png",
  ])("does not report %s", async (path) => {
    await expect(run([added(path)])).resolves.toEqual([]);
  });

  it("reports an edited credential file but not a removed one", async () => {
    await expect(run([buildFile({ path: ".env", status: "modified" })])).resolves.toHaveLength(1);
    await expect(
      run([buildFile({ path: ".env", status: "removed", additions: 0, deletions: 4 })]),
    ).resolves.toEqual([]);
  });

  it("honours configured patterns and allow list", async () => {
    const files = [added("secrets/prod.yaml"), added("secrets/example.yaml"), added(".env")];

    const findings = await run(files, {
      patterns: ["secrets/**"],
      allow: ["secrets/example.yaml"],
    });

    expect(findings.map((finding) => finding.filePath)).toEqual(["secrets/prod.yaml"]);
  });

  it("lists up to the limit one by one and counts the rest", async () => {
    const files = Array.from({ length: 4 }, (_unused, index) => added(`keys/k${index}.pem`));

    const findings = await run(files, { maxFindings: 3 });

    expect(findings).toHaveLength(4);
    expect(findings[3]?.message).toBe(
      "1 more file that usually holds credentials is part of the pull request.",
    );
    expect(findings[3]).not.toHaveProperty("filePath");
  });

  it("uses the plural for several unlisted files", async () => {
    const files = Array.from({ length: 3 }, (_unused, index) => added(`keys/k${index}.pem`));

    const findings = await run(files, { maxFindings: 1 });

    expect(findings[1]?.message).toBe(
      "2 more files that usually hold credentials are part of the pull request.",
    );
  });

  it.each([{ patterns: "x" }, { allow: [5] }, { maxFindings: 0 }, { other: 1 }])(
    "rejects the options %j",
    (options) => {
      expect(credentialFilesRule.optionsSchema.safeParse(options).success).toBe(false);
    },
  );
});

describe("sensitive-file-changes", () => {
  const run = (files: FileInput[], options?: unknown): ReturnType<typeof runRuleWith> =>
    runRuleWith(sensitiveFileChangesRule, buildContext({ files }), options);

  it("reports changed build and review files in one finding", async () => {
    const files = [
      buildFile({ path: ".github/workflows/ci.yml" }),
      buildFile({ path: "Dockerfile" }),
      buildFile({ path: "src/index.ts" }),
    ];

    await expect(run(files)).resolves.toEqual([
      {
        message:
          "The pull request changes 2 files that control how the project is built, deployed or reviewed.",
        evidence: [{ label: "Files", value: ".github/workflows/ci.yml, Dockerfile" }],
        suggestion: "Have someone who owns these files look at the change.",
      },
    ]);
  });

  it("uses the singular for one file", async () => {
    const [finding] = await run([buildFile({ path: "CODEOWNERS" })]);

    expect(finding?.message).toBe(
      "The pull request changes 1 file that controls how the project is built, deployed or reviewed.",
    );
  });

  it.each([
    ".github/workflows/release.yaml",
    ".github/actions/setup/action.yml",
    ".github/dependabot.yml",
    ".github/pr-buddy.json",
    ".github/CODEOWNERS",
    "docker/api.Dockerfile",
    "services/web/Dockerfile.prod",
    "compose.yaml",
    "infra/docker-compose.override.yml",
    ".npmrc",
  ])("reports a change to %s", async (path) => {
    await expect(run([buildFile({ path })])).resolves.toHaveLength(1);
  });

  it.each([
    "src/workflows/ci.yml",
    "docs/docker.md",
    "src/Dockerfile.ts.bak/readme",
    "package.json",
  ])("does not report a change to %s", async (path) => {
    await expect(run([buildFile({ path })])).resolves.toEqual([]);
  });

  it("reports a removed sensitive file too", async () => {
    const file = buildFile({ path: "CODEOWNERS", status: "removed", additions: 0, deletions: 3 });

    await expect(run([file])).resolves.toHaveLength(1);
  });

  it("lists at most five files", async () => {
    const files = Array.from({ length: 7 }, (_unused, index) =>
      buildFile({ path: `.github/workflows/job-${index}.yml` }),
    );

    const [finding] = await run(files);

    expect(finding?.evidence[0]?.value).toMatch(/\(and 2 more\)$/);
  });

  it("honours configured patterns, which replace the defaults", async () => {
    const files = [buildFile({ path: "infra/main.tf" }), buildFile({ path: "Dockerfile" })];

    const [finding] = await run(files, { patterns: ["**/*.tf"] });

    expect(finding?.evidence).toEqual([{ label: "Files", value: "infra/main.tf" }]);
  });

  it.each([{ patterns: [] }, { patterns: "x" }, { other: 1 }])(
    "rejects the options %j",
    (options) => {
      expect(sensitiveFileChangesRule.optionsSchema.safeParse(options).success).toBe(false);
    },
  );
});
