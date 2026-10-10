import { describe, expect, it } from "vitest";
import { getNewSideLines, parsePatch } from "../../../src/diff/parse-patch.js";

const lines = (patch: string): number[] => [...getNewSideLines(patch)].sort((a, b) => a - b);

describe("parsePatch", () => {
  it("numbers added and context lines on the new side", () => {
    const patch = [
      "@@ -10,4 +10,5 @@ function example() {",
      " one",
      "-two",
      "+TWO",
      "+extra",
      " three",
      " four",
    ].join("\n");

    expect(parsePatch(patch)).toEqual([
      {
        oldStart: 10,
        oldLines: 4,
        newStart: 10,
        newLines: 5,
        addedLines: [11, 12],
        contextLines: [10, 13, 14],
      },
    ]);
  });

  it("parses several hunks", () => {
    const patch = ["@@ -1,2 +1,3 @@", " a", "+b", " c", "@@ -20,2 +21,2 @@", "-x", "+y", " z"].join(
      "\n",
    );

    const hunks = parsePatch(patch);

    expect(hunks).toHaveLength(2);
    expect(lines(patch)).toEqual([1, 2, 3, 21, 22]);
  });

  it("treats a missing count as one line", () => {
    const patch = "@@ -3 +3 @@\n-old\n+new";

    expect(parsePatch(patch)).toMatchObject([{ oldLines: 1, newLines: 1, addedLines: [3] }]);
  });

  it("parses a newly added file", () => {
    expect(lines("@@ -0,0 +1,3 @@\n+a\n+b\n+c")).toEqual([1, 2, 3]);
  });

  it("finds no new-side lines in a deleted file", () => {
    expect(lines("@@ -1,3 +0,0 @@\n-a\n-b\n-c")).toEqual([]);
  });

  it("ignores the no-newline marker", () => {
    const patch =
      "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file";

    expect(lines(patch)).toEqual([1]);
  });

  it("accepts an empty context line whose leading space was stripped", () => {
    expect(lines("@@ -1,3 +1,3 @@\n a\n\n c")).toEqual([1, 2, 3]);
  });

  it("does not count a trailing newline as a line", () => {
    expect(lines("@@ -0,0 +1,2 @@\n+a\n+b\n")).toEqual([1, 2]);
  });

  it("ignores lines beyond the size a hunk declares", () => {
    expect(lines("@@ -1,1 +1,1 @@\n-a\n+b\n+not declared\n also not declared\n-nor this")).toEqual([
      1,
    ]);
  });

  it("ignores text before the first hunk", () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b";

    expect(lines(patch)).toEqual([1]);
  });

  it.each([
    ["an empty string", ""],
    ["text without hunks", "+added\n-removed\n context"],
    ["a malformed header", "@@ -x,1 +y,1 @@\n+a"],
    ["a header with oversized numbers", "@@ -1,1 +12345678901,1 @@\n+a"],
  ])("returns no hunks for %s", (_name, patch) => {
    expect(parsePatch(patch)).toEqual([]);
  });

  it("parses a large patch", () => {
    const count = 50_000;
    const patch = `@@ -0,0 +1,${count} @@\n${"+line\n".repeat(count)}`;

    expect(getNewSideLines(patch).size).toBe(count);
  });
});
