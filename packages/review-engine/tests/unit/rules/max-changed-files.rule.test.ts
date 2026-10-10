import { describe, expect, it } from "vitest";
import { MAX_FILES } from "../../../src/limits.js";
import { maxChangedFilesRule } from "../../../src/rules/max-changed-files.rule.js";
import {
  buildContext,
  buildFile,
  buildFiles,
  runRuleWith,
  type FileInput,
} from "../../helpers/builders.js";

const run = (files: FileInput[], options?: unknown): ReturnType<typeof runRuleWith> =>
  runRuleWith(maxChangedFilesRule, buildContext({ files }), options);

describe("max-changed-files", () => {
  it("reports nothing at the default limit of 30 files", async () => {
    await expect(run(buildFiles(30))).resolves.toEqual([]);
  });

  it("reports a pull request one file over the limit", async () => {
    const findings = await run(buildFiles(31));

    expect(findings).toEqual([
      {
        message: "The pull request changes 31 files, more than the configured maximum of 30.",
        evidence: [
          { label: "Changed files counted", value: "31" },
          { label: "Configured maximum", value: "30" },
        ],
        suggestion: expect.stringContaining("smaller pull requests") as string,
      },
    ]);
  });

  it("reports nothing for an empty diff", async () => {
    await expect(run([])).resolves.toEqual([]);
  });

  it("honours a configured limit", async () => {
    await expect(run(buildFiles(3), { maxFiles: 3 })).resolves.toEqual([]);
    await expect(run(buildFiles(4), { maxFiles: 3 })).resolves.toHaveLength(1);
  });

  it("counts added, removed and renamed files alike", async () => {
    const files = [
      buildFile({ path: "src/added.ts", status: "added" }),
      buildFile({ path: "src/removed.ts", status: "removed" }),
      buildFile({ path: "src/new-name.ts", previousPath: "src/old-name.ts", status: "renamed" }),
    ];

    const findings = await run(files, { maxFiles: 2 });

    expect(findings[0]?.evidence[0]).toEqual({ label: "Changed files counted", value: "3" });
  });

  it("does not count lockfiles by default", async () => {
    const files = [
      ...buildFiles(30),
      buildFile({ path: "package-lock.json" }),
      buildFile({ path: "apps/web/yarn.lock" }),
      buildFile({ path: "pnpm-lock.yaml" }),
    ];

    await expect(run(files)).resolves.toEqual([]);
  });

  it("states how many files were excluded when it reports", async () => {
    const files = [...buildFiles(31), buildFile({ path: "package-lock.json" })];

    const findings = await run(files);

    expect(findings[0]?.evidence).toContainEqual({
      label: "Files excluded from the count",
      value: "1",
    });
  });

  it("honours configured exclusions, which replace the defaults", async () => {
    const files = [
      ...buildFiles(2),
      buildFile({ path: "src/generated/client.ts" }),
      buildFile({ path: "package-lock.json" }),
    ];

    await expect(run(files, { maxFiles: 3, exclude: ["src/generated/**"] })).resolves.toEqual([]);
    await expect(run(files, { maxFiles: 2, exclude: ["src/generated/**"] })).resolves.toHaveLength(
      1,
    );
    await expect(run(files, { maxFiles: 3, exclude: [] })).resolves.toHaveLength(1);
  });

  it("never reports a file or line", async () => {
    const [finding] = await run(buildFiles(31));

    expect(finding).not.toHaveProperty("filePath");
    expect(finding).not.toHaveProperty("line");
  });

  it.each([
    ["a limit of zero", { maxFiles: 0 }],
    ["a fractional limit", { maxFiles: 2.5 }],
    ["a limit above the engine maximum", { maxFiles: MAX_FILES + 1 }],
    ["a string limit", { maxFiles: "30" }],
    ["exclusions that are not a list", { exclude: "**/*.lock" }],
    ["an empty exclusion pattern", { exclude: [""] }],
    ["an unknown option", { max: 30 }],
  ])("rejects options with %s", (_name, options) => {
    expect(maxChangedFilesRule.optionsSchema.safeParse(options).success).toBe(false);
  });
});
