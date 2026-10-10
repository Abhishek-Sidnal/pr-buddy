import { describe, expect, it } from "vitest";
import { getNewSideLines, getVisibleLines, parsePatch } from "../../../src/diff/parse-patch.js";

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
        addedLineTexts: ["TWO", "extra"],
        contextLines: [10, 13, 14],
        contextLineTexts: ["one", "three", "four"],
        isWellFormed: true,
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

  it.each([
    ["an added line", "+not declared"],
    ["a context line", " not declared"],
    ["a removed line", "-not declared"],
    ["a blank line", "\n+after the blank"],
  ])("does not trust a hunk that has %s beyond its declared size", (_name, extra) => {
    const patch = `@@ -1,1 +1,1 @@\n-a\n+b\n${extra}`;

    expect(parsePatch(patch)).toMatchObject([{ isWellFormed: false }]);
    expect(lines(patch)).toEqual([]);
  });

  it.each([
    ["missing new-side lines", "@@ -1,3 +1,3 @@\n a\n b"],
    ["missing old-side lines", "@@ -1,2 +1,1 @@\n a"],
    ["only its header", "@@ -4,2 +4,2 @@"],
  ])("does not trust a hunk that is cut short, with %s", (_name, patch) => {
    expect(parsePatch(patch)).toMatchObject([{ isWellFormed: false }]);
    expect(lines(patch)).toEqual([]);
  });

  it("does not let a trailing newline complete a hunk that was cut short", () => {
    // The hunk declares three lines and has two. The final newline must not become the third.
    const patch = "@@ -1,3 +1,3 @@\n a\n b\n";

    expect(parsePatch(patch)).toMatchObject([{ contextLines: [1, 2], isWellFormed: false }]);
    expect(lines(patch)).toEqual([]);
  });

  it("keeps the lines of well-formed hunks when another hunk is malformed", () => {
    const patch = "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,3 +10,3 @@\n cut short\n@@ -20 +20 @@\n-x\n+y";

    expect(parsePatch(patch).map((hunk) => hunk.isWellFormed)).toEqual([true, false, true]);
    expect(lines(patch)).toEqual([1, 20]);
  });

  it("ignores lines that are not part of a diff after a complete hunk", () => {
    expect(lines("@@ -1 +1 @@\n-a\n+b\ndiff --git a/next b/next")).toEqual([1]);
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

describe("getVisibleLines", () => {
  it("returns added and unchanged lines in file order, without removed ones", () => {
    const patch = ["@@ -10,3 +10,4 @@", " one", "-two", "+TWO", "+extra", " three"].join("\n");

    expect(getVisibleLines(patch)).toEqual([
      { line: 10, text: "one", isAdded: false },
      { line: 11, text: "TWO", isAdded: true },
      { line: 12, text: "extra", isAdded: true },
      { line: 13, text: "three", isAdded: false },
    ]);
  });

  it("keeps an empty context line whose leading space was stripped", () => {
    expect(getVisibleLines(["@@ -1,2 +1,2 @@", "", "-a", "+b"].join("\n"))).toEqual([
      { line: 1, text: "", isAdded: false },
      { line: 2, text: "b", isAdded: true },
    ]);
  });

  it("orders lines across hunks", () => {
    const patch = ["@@ -0,0 +1 @@", "+first", "@@ -20,1 +20,2 @@", " kept", "+second"].join("\n");

    expect(getVisibleLines(patch).map(({ line }) => line)).toEqual([1, 20, 21]);
  });

  it("ignores a hunk that does not match its header", () => {
    const patch = ["@@ -1,1 +1,5 @@", "+only one", "@@ -8,0 +9 @@", "+fine"].join("\n");

    expect(getVisibleLines(patch)).toEqual([{ line: 9, text: "fine", isAdded: true }]);
  });

  it("returns nothing for text that is not a patch", () => {
    expect(getVisibleLines("not a patch")).toEqual([]);
  });
});
