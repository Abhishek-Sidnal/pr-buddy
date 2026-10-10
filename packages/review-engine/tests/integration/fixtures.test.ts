import { describe, expect, it } from "vitest";
import {
  createBuiltinRegistry,
  createReviewEngine,
  defineRule,
  findingSchema,
  parsePatch,
  parseReviewContext,
} from "../../src/index.js";
import { z } from "zod";
import {
  loadContextFixture,
  loadExampleConfig,
  type ContextFixtureName,
} from "../helpers/fixtures.js";

const ALL_FIXTURES: ContextFixtureName[] = [
  "added-files",
  "empty-diff",
  "feature-with-tests",
  "removed-files",
  "renamed-files",
];

describe("fixtures", () => {
  it.each(ALL_FIXTURES)("%s is a valid review context", (name) => {
    expect(() => parseReviewContext(loadContextFixture(name))).not.toThrow();
  });

  it.each(ALL_FIXTURES)("%s has patches consistent with its line counts", (name) => {
    for (const file of parseReviewContext(loadContextFixture(name)).files) {
      if (file.patch === undefined) {
        continue;
      }
      const hunks = parsePatch(file.patch);
      const added = hunks.reduce((total, hunk) => total + hunk.addedLines.length, 0);
      const newSide = hunks.reduce(
        (total, hunk) => total + hunk.addedLines.length + hunk.contextLines.length,
        0,
      );
      const declaredNewSide = hunks.reduce((total, hunk) => total + hunk.newLines, 0);

      expect(added, `${file.path}: additions`).toBe(file.additions);
      expect(newSide, `${file.path}: new-side lines`).toBe(declaredNewSide);
    }
  });

  it.each(ALL_FIXTURES)("%s produces only schema-valid findings", async (name) => {
    const result = await createReviewEngine().review(loadContextFixture(name));

    for (const finding of result.findings) {
      expect(findingSchema.safeParse(finding).success).toBe(true);
    }
    expect(result.rules.every((rule) => rule.status === "completed")).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("reviewing fixtures with default configuration", () => {
  const review = async (name: ContextFixtureName): Promise<string[]> => {
    const result = await createReviewEngine().review(loadContextFixture(name));
    return result.findings.map((finding) => finding.ruleId);
  };

  it("flags added source files that have no description and no tests", async () => {
    await expect(review("added-files")).resolves.toEqual([
      "missing-test-changes",
      "pr-description",
    ]);
  });

  it("reports nothing when files are only removed", async () => {
    await expect(review("removed-files")).resolves.toEqual([]);
  });

  it("flags the edited rename but not the pure rename", async () => {
    const result = await createReviewEngine().review(loadContextFixture("renamed-files"));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ruleId: "missing-test-changes",
      evidence: expect.arrayContaining([
        { label: "Edited source files", value: "src/shared/format.ts" },
      ]) as unknown[],
    });
  });

  it("reports nothing for an empty diff", async () => {
    await expect(review("empty-diff")).resolves.toEqual([]);
  });

  it("reports nothing for a described change that includes tests", async () => {
    await expect(review("feature-with-tests")).resolves.toEqual([]);
  });
});

describe("example configuration", () => {
  it("is accepted by the engine", () => {
    const engine = createReviewEngine({ config: loadExampleConfig() });

    expect(engine.rules).toEqual([
      expect.objectContaining({ id: "pr-description", enabled: true, severity: "low" }),
      expect.objectContaining({ id: "max-changed-files", enabled: true, severity: "high" }),
      expect.objectContaining({ id: "max-changed-lines", enabled: true }),
      expect.objectContaining({ id: "missing-test-changes", enabled: true, severity: "low" }),
      expect.objectContaining({ id: "debug-statements", enabled: true }),
      expect.objectContaining({ id: "credential-files", enabled: true }),
      expect.objectContaining({ id: "sensitive-file-changes", enabled: true }),
    ]);
  });

  it("changes what is reported", async () => {
    const engine = createReviewEngine({ config: loadExampleConfig() });

    const result = await engine.review(loadContextFixture("renamed-files"));

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(["missing-test-changes"]);
    expect(result.findings[0]?.evidence[1]?.value).toBe("**/*.test.{ts,tsx}, tests/**");
  });
});

describe("locations against a realistic diff", () => {
  const nullCheckRule = defineRule({
    id: "located-rule",
    version: "1.0.0",
    description: "Reports fixed locations to exercise location validation.",
    defaultSeverity: "medium",
    optionsSchema: z.strictObject({}),
    run: () => [
      {
        message: "On an added line.",
        evidence: [{ label: "Line", value: "8" }],
        filePath: "src/services/user.service.ts",
        line: 8,
      },
      {
        message: "On a line outside the diff.",
        evidence: [{ label: "Line", value: "2" }],
        filePath: "src/services/user.service.ts",
        line: 2,
      },
      {
        message: "On a binary file.",
        evidence: [{ label: "Line", value: "1" }],
        filePath: "docs/images/lookup-flow.png",
        line: 1,
      },
    ],
  });

  it("keeps verifiable locations and removes the rest", async () => {
    const engine = createReviewEngine({
      registry: createBuiltinRegistry().register(nullCheckRule),
    });

    const result = await engine.review(loadContextFixture("feature-with-tests"));

    expect(
      result.findings.map(({ message, filePath, line }) => ({ message, filePath, line })),
    ).toEqual([
      { message: "On a binary file.", filePath: "docs/images/lookup-flow.png", line: undefined },
      {
        message: "On a line outside the diff.",
        filePath: "src/services/user.service.ts",
        line: undefined,
      },
      { message: "On an added line.", filePath: "src/services/user.service.ts", line: 8 },
    ]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      "LOCATION_REMOVED",
      "LOCATION_REMOVED",
    ]);
  });
});
