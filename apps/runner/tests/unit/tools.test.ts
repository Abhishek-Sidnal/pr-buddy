import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { AiTool } from "@pr-buddy/ai-reviewer";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_LIST_ENTRIES,
  MAX_READ_LINES,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_TOOL_FILE_BYTES,
  MAX_TOOL_LINE_LENGTH,
  MAX_TOOL_RESPONSE_LENGTH,
} from "../../src/limits.js";
import { createCheckoutTools } from "../../src/tools/checkout-tools.js";
import { PATH_REFUSALS, TEXT_REFUSALS } from "../../src/tools/checkout.js";
import { byName, createListFilesTool } from "../../src/tools/list-files.js";
import { createReadFileTool } from "../../src/tools/read-file.js";
import { createReadRecord } from "../../src/tools/read-record.js";
import { createSearchTool, SEARCH_LIMITS } from "../../src/tools/search.js";
import { BUDGET_REACHED, createOutputBudget, INVALID_INPUT } from "../../src/tools/tool-context.js";
import { createTempCheckout, removeTempCheckouts } from "../helpers/temp-checkout.js";

afterEach(removeTempCheckouts);

const numbered = (count: number, text = "line"): string =>
  Array.from({ length: count }, (_unused, index) => `${text} ${index + 1}`).join("\n");

describe("the record of what was read", () => {
  it("knows the lines it was given, and no others", () => {
    const record = createReadRecord();
    record.addRange("src/a.ts", 3, 5);
    record.addLine("src/b.ts", 9);
    record.addLine("src/b.ts", 9);

    expect(record.hasLine("src/a.ts", 3)).toBe(true);
    expect(record.hasLine("src/a.ts", 5)).toBe(true);
    expect(record.hasLine("src/a.ts", 2)).toBe(false);
    expect(record.hasLine("src/a.ts", 6)).toBe(false);
    expect(record.hasLine("src/c.ts", 3)).toBe(false);
    expect(record.hasFile("src/b.ts")).toBe(true);
    expect(record.hasFile("src/c.ts")).toBe(false);
    expect(record.fileCount).toBe(2);
    expect(record.lineCount).toBe(4);
  });
});

describe("the budget for tool output", () => {
  it("gives until the limit, then refuses and says it is exhausted", () => {
    const budget = createOutputBudget(10);

    expect(budget.take(6)).toBe(true);
    expect(budget.take(4)).toBe(true);
    expect(budget.isExhausted).toBe(false);
    expect(budget.take(1)).toBe(false);
    expect(budget.isExhausted).toBe(true);
    expect(budget.usedLength).toBe(10);
  });
});

describe("the set of tools", () => {
  it("is three tools that only read, each with a schema for its input", async () => {
    const { context } = await createTempCheckout();
    const tools = createCheckoutTools(context);

    expect(tools.map((tool) => tool.name)).toEqual(["read_file", "search", "list_files"]);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
  });
});

describe("read_file", () => {
  it("returns a file's lines with their numbers and records them", async () => {
    const { context, record } = await createTempCheckout({ "src/a.ts": "one\ntwo\nthree\n" });

    const result = await createReadFileTool(context).run({ path: "src/a.ts" });

    expect(result).toEqual({
      text: "src/a.ts, lines 1 to 3 of 3:\n1: one\n2: two\n3: three",
      isRefused: false,
    });
    expect(record.hasLine("src/a.ts", 1)).toBe(true);
    expect(record.hasLine("src/a.ts", 3)).toBe(true);
    expect(record.lineCount).toBe(3);
  });

  it("returns the range that was asked for, and records only that", async () => {
    const { context, record } = await createTempCheckout({ "a.txt": numbered(20) });

    const result = await createReadFileTool(context).run({
      path: "./a.txt",
      startLine: 5,
      lineCount: 3,
    });

    expect(result.text).toBe("a.txt, lines 5 to 7 of 20:\n5: line 5\n6: line 6\n7: line 7");
    expect(record.hasLine("a.txt", 4)).toBe(false);
    expect(record.hasLine("a.txt", 7)).toBe(true);
    expect(record.hasLine("a.txt", 8)).toBe(false);
  });

  it("returns no more lines than its limit, however many are asked for", async () => {
    const { context, record } = await createTempCheckout({
      "a.txt": numbered(MAX_READ_LINES + 50),
    });

    const result = await createReadFileTool(context).run({ path: "a.txt", lineCount: 1_000_000 });

    expect(result.text.split("\n")[0]).toBe(
      `a.txt, lines 1 to ${MAX_READ_LINES} of ${MAX_READ_LINES + 50}:`,
    );
    expect(record.lineCount).toBe(MAX_READ_LINES);
  });

  it("stops at the end of the file", async () => {
    const { context, record } = await createTempCheckout({ "a.txt": numbered(4) });

    const result = await createReadFileTool(context).run({ path: "a.txt", startLine: 3 });

    expect(result.text).toBe("a.txt, lines 3 to 4 of 4:\n3: line 3\n4: line 4");
    expect(record.lineCount).toBe(2);
  });

  it("cuts a long line, and stops when the answer would be too long", async () => {
    const long = "x".repeat(MAX_TOOL_LINE_LENGTH + 100);
    const { context, record } = await createTempCheckout({
      "min.js": Array.from({ length: 300 }, () => long).join("\n"),
    });

    const result = await createReadFileTool(context).run({ path: "min.js" });
    const [header, first, ...rest] = result.text.split("\n");

    expect(first).toBe(`1: ${"x".repeat(MAX_TOOL_LINE_LENGTH)}…`);
    expect(result.text.length).toBeLessThanOrEqual(MAX_TOOL_RESPONSE_LENGTH);
    expect(rest.length + 1).toBeLessThan(300);
    // The header and the record both say what was really returned.
    expect(header).toBe(`min.js, lines 1 to ${rest.length + 1} of 300:`);
    expect(record.lineCount).toBe(rest.length + 1);
    expect(record.hasLine("min.js", rest.length + 2)).toBe(false);
  });

  it("says that an empty file is empty", async () => {
    const { context, record } = await createTempCheckout({ "empty.txt": "" });

    expect(await createReadFileTool(context).run({ path: "empty.txt" })).toEqual({
      text: "empty.txt is empty.",
      isRefused: false,
    });
    expect(record.fileCount).toBe(0);
  });

  it("refuses a line beyond the end, and records nothing", async () => {
    const { context, record } = await createTempCheckout({ "a.txt": numbered(4) });

    expect(await createReadFileTool(context).run({ path: "a.txt", startLine: 5 })).toEqual({
      text: "a.txt has 4 lines; there is no line 5.",
      isRefused: true,
    });
    expect(record.fileCount).toBe(0);
  });

  it.each([
    [undefined],
    ["a.txt"],
    [{}],
    [{ path: "" }],
    [{ path: 7 }],
    [{ path: "a.txt", startLine: 0 }],
    [{ path: "a.txt", startLine: 1.5 }],
    [{ path: "a.txt", lineCount: 0 }],
    [{ path: "a.txt", lineCount: "all" }],
  ])("refuses the input %j", async (input) => {
    const { context } = await createTempCheckout({ "a.txt": "one\n" });

    expect(await createReadFileTool(context).run(input)).toEqual({
      text: INVALID_INPUT,
      isRefused: true,
    });
  });

  it("refuses a credential file, Git's data, a folder, a large file and a binary one", async () => {
    const { context, record } = await createTempCheckout({
      ".env": "SECRET-CANARY=1\n",
      "src/a.ts": "one\n",
      "big.sql": "x".repeat(MAX_TOOL_FILE_BYTES + 1),
      "logo.png": new Uint8Array([0, 1, 2]),
    });
    const tool = createReadFileTool(context);

    expect(await tool.run({ path: ".env" })).toEqual({
      text: PATH_REFUSALS.protected,
      isRefused: true,
    });
    expect((await tool.run({ path: ".git/config" })).text).toBe(PATH_REFUSALS.protected);
    expect((await tool.run({ path: "../outside" })).text).toBe(PATH_REFUSALS.outside);
    expect((await tool.run({ path: "nope.ts" })).text).toBe(PATH_REFUSALS["not-found"]);
    expect((await tool.run({ path: "src" })).text).toBe(TEXT_REFUSALS["not-a-file"]);
    expect((await tool.run({ path: "big.sql" })).text).toBe(TEXT_REFUSALS["too-large"]);
    expect((await tool.run({ path: "logo.png" })).text).toBe(TEXT_REFUSALS.binary);
    expect(record.fileCount).toBe(0);
  });

  it("cannot be led to the process's environment through a link", async () => {
    const { root, context } = await createTempCheckout({ ".env": "ENV-FILE-CANARY\n" });
    process.env["PR_BUDDY_TEST_CANARY"] = "ENVIRONMENT-CANARY";
    await symlink("/proc/self/environ", join(root, "notes.txt"));
    await symlink(join(root, ".env"), join(root, "readme.txt"));
    await symlink("/proc/self", join(root, "self"));
    const tool = createReadFileTool(context);

    try {
      for (const path of ["notes.txt", "readme.txt", "self/environ", "/proc/self/environ"]) {
        const result = await tool.run({ path });
        expect(result.isRefused).toBe(true);
        expect(result.text).not.toContain("CANARY");
      }
    } finally {
      delete process.env["PR_BUDDY_TEST_CANARY"];
    }
  });

  it("returns nothing and records nothing once the review's budget is used up", async () => {
    const { context, record, budget } = await createTempCheckout({ "a.txt": numbered(20) }, 30);
    const tool = createReadFileTool(context);

    expect(await tool.run({ path: "a.txt" })).toEqual({ text: BUDGET_REACHED, isRefused: true });
    expect(record.fileCount).toBe(0);
    expect(budget.isExhausted).toBe(true);
  });
});

describe("search", () => {
  const files = {
    "src/b.ts": "import { total } from './a';\nconst x = total(1);\n",
    "src/a.ts": "export function total(n: number) {\n  return n;\n}\n",
    "src/deep/c.ts": "// total is used here\n",
    "README.md": "The total is computed.\n",
    "zz.txt": "total\n",
  };

  it("finds every line with the text, files first and in name order, and records them", async () => {
    const { context, record } = await createTempCheckout(files);

    const result = await createSearchTool(context).run({ query: "total" });

    expect(result).toEqual({
      text: [
        "6 matching lines; 5 files were read:",
        "README.md:1: The total is computed.",
        "zz.txt:1: total",
        "src/a.ts:1: export function total(n: number) {",
        "src/b.ts:1: import { total } from './a';",
        "src/b.ts:2: const x = total(1);",
        "src/deep/c.ts:1: // total is used here",
      ].join("\n"),
      isRefused: false,
    });
    expect(record.hasLine("src/b.ts", 2)).toBe(true);
    expect(record.hasLine("src/a.ts", 2)).toBe(false);
    expect(record.lineCount).toBe(6);
  });

  it("looks in one folder, or in one file, when given a path", async () => {
    const { context } = await createTempCheckout(files);
    const tool = createSearchTool(context);

    expect((await tool.run({ query: "total", path: "src/deep" })).text).toBe(
      "1 matching line; 1 file was read:\nsrc/deep/c.ts:1: // total is used here",
    );
    expect((await tool.run({ query: "total", path: "src/a.ts" })).text).toBe(
      "1 matching line; 1 file was read:\nsrc/a.ts:1: export function total(n: number) {",
    );
  });

  it("compares text literally: no patterns, and capitals count", async () => {
    const { context, record } = await createTempCheckout({
      "a.txt": "abc\na.c\nA.C\n(x+)+$\n",
    });
    const tool = createSearchTool(context);

    expect((await tool.run({ query: "a.c" })).text).toBe(
      "1 matching line; 1 file was read:\na.txt:2: a.c",
    );
    expect((await tool.run({ query: "(x+)+$" })).text).toContain("a.txt:4: (x+)+$");
    expect((await tool.run({ query: "nothing-here" })).text).toBe(
      "No line contains that text; 1 file was read.",
    );
    expect(record.lineCount).toBe(2);
  });

  it("passes over Git's data, credential files, lockfiles, links, large and binary files", async () => {
    const { root, context } = await createTempCheckout({
      ".env": "needle SECRET-CANARY\n",
      "config/server.key": "needle KEY-CANARY\n",
      "package-lock.json": "needle\n",
      "big.sql": `needle${"x".repeat(MAX_TOOL_FILE_BYTES)}`,
      "logo.png": new Uint8Array([110, 101, 101, 100, 108, 101, 0]),
      "src/a.ts": "needle here\n",
    });
    await symlink(join(root, ".env"), join(root, "link.txt"));
    await symlink("/proc/self", join(root, "self"));
    await mkdir(join(root, "vendor/.git"), { recursive: true });

    const result = await createSearchTool(context).run({ query: "needle" });

    expect(result.text).toBe("1 matching line; 1 file was read:\nsrc/a.ts:1: needle here");
    // `.git/config` holds a canary too, and was never opened.
    expect((await createSearchTool(context).run({ query: "CANARY" })).text).toBe(
      "No line contains that text; 1 file was read.",
    );
  });

  it("cuts a long matching line", async () => {
    const { context } = await createTempCheckout({
      "min.js": `needle${"x".repeat(MAX_TOOL_LINE_LENGTH)}\n`,
    });

    const result = await createSearchTool(context).run({ query: "needle" });

    expect(result.text.endsWith("…")).toBe(true);
    expect(result.text.length).toBeLessThan(MAX_TOOL_LINE_LENGTH + 100);
  });

  it.each([
    ["matches", { maxMatches: 2 }, "2 matching lines; 2 files were read:"],
    ["files", { maxFiles: 2 }, "3 matching lines; 2 files were read:"],
    ["bytes", { maxBytes: 1 }, "1 matching line; 1 file was read:"],
    // Git's own folder is an entry too: it is looked at, and passed over.
    ["folder entries", { maxEntries: 2 }, "1 matching line; 1 file was read:"],
  ])("stops at its limit on %s and says so", async (_name, limit, header) => {
    const { context, record } = await createTempCheckout({
      "a.txt": "needle\n",
      "b.txt": "needle\nneedle\n",
      "c.txt": "needle\n",
    });

    const result = await createSearchTool(context, { ...SEARCH_LIMITS, ...limit }).run({
      query: "needle",
    });
    const lines = result.text.split("\n");

    expect(lines[0]).toBe(header);
    expect(lines.at(-1)).toMatch(/^The search stopped at a limit/);
    expect(result.isRefused).toBe(false);
    // Only what was returned counts as read.
    expect(record.lineCount).toBe(lines.length - 2);
  });

  it("stops when the answer would be too long", async () => {
    const line = `needle${"x".repeat(MAX_TOOL_LINE_LENGTH)}`;
    const { context, record } = await createTempCheckout({
      "min.js": Array.from({ length: 200 }, () => line).join("\n"),
    });

    const result = await createSearchTool(context, { ...SEARCH_LIMITS, maxMatches: 1_000 }).run({
      query: "needle",
    });

    expect(result.text.length).toBeLessThanOrEqual(MAX_TOOL_RESPONSE_LENGTH);
    expect(result.text).toMatch(/The search stopped at a limit/);
    expect(record.lineCount).toBeLessThan(200);
    expect(record.lineCount).toBeGreaterThan(10);
  });

  it.each([
    [undefined],
    [{}],
    [{ query: "ab" }],
    [{ query: "x".repeat(MAX_SEARCH_QUERY_LENGTH + 1) }],
    [{ query: "two\nlines" }],
    [{ query: "nul\0byte" }],
    [{ query: 123 }],
    [{ query: "needle", path: 5 }],
  ])("refuses the input %j", async (input) => {
    const { context } = await createTempCheckout({ "a.txt": "needle\n" });

    expect(await createSearchTool(context).run(input)).toEqual({
      text: INVALID_INPUT,
      isRefused: true,
    });
  });

  it("refuses a path it may not look in", async () => {
    const { context } = await createTempCheckout({ ".env": "needle\n" });
    const tool = createSearchTool(context);

    expect((await tool.run({ query: "needle", path: ".env" })).text).toBe(PATH_REFUSALS.protected);
    expect((await tool.run({ query: "needle", path: ".git" })).text).toBe(PATH_REFUSALS.protected);
    expect((await tool.run({ query: "needle", path: ".." })).text).toBe(PATH_REFUSALS.outside);
    expect((await tool.run({ query: "needle", path: "nope" })).text).toBe(
      PATH_REFUSALS["not-found"],
    );
  });

  it("records nothing when the review's budget is used up", async () => {
    const { context, record } = await createTempCheckout({ "a.txt": "needle\n" }, 10);

    expect(await createSearchTool(context).run({ query: "needle" })).toEqual({
      text: BUDGET_REACHED,
      isRefused: true,
    });
    expect(record.fileCount).toBe(0);
  });
});

describe("list_files", () => {
  it("lists a folder's own entries by name, folders with a slash, without Git's data", async () => {
    const { context, record } = await createTempCheckout({
      "src/b.ts": "",
      "src/a.ts": "",
      "src/deep/c.ts": "",
      "README.md": "",
      ".env": "SECRET-CANARY",
    });
    const tool = createListFilesTool(context);

    expect(await tool.run({})).toEqual({
      text: "The root has 3 entries:\n.env\nREADME.md\nsrc/",
      isRefused: false,
    });
    expect((await tool.run({ path: "src" })).text).toBe("src/ has 3 entries:\na.ts\nb.ts\ndeep/");
    expect((await tool.run({ path: "src/deep/" })).text).toBe("src/deep/ has 1 entry:\nc.ts");
    // Names were returned and nothing was read.
    expect(record.fileCount).toBe(0);
  });

  it("leaves out links and counts them", async () => {
    const { root, context } = await createTempCheckout({ "a.txt": "" });
    await symlink("/etc", join(root, "system"));
    await symlink(join(root, "a.txt"), join(root, "b.txt"));

    expect((await createListFilesTool(context).run({})).text).toBe(
      "The root has 1 entry:\na.txt\n2 that are links or special files are left out.",
    );
  });

  it("lists an empty folder", async () => {
    const { root, context } = await createTempCheckout();
    await mkdir(join(root, "empty"));

    expect((await createListFilesTool(context).run({ path: "empty" })).text).toBe(
      "empty/ has 0 entries:",
    );
  });

  it("lists no more than its limit and counts the rest", async () => {
    const names = Array.from({ length: MAX_LIST_ENTRIES + 5 }, (_unused, index) => [
      `many/f${String(index).padStart(4, "0")}.txt`,
      "",
    ]);
    const { context } = await createTempCheckout(
      Object.fromEntries(names) as Record<string, string>,
    );

    const lines = (await createListFilesTool(context).run({ path: "many" })).text.split("\n");

    expect(lines[0]).toBe(`many/ has ${MAX_LIST_ENTRIES + 5} entries:`);
    expect(lines).toHaveLength(MAX_LIST_ENTRIES + 2);
    expect(lines.at(-1)).toBe("5 more are not listed.");
  });

  it("refuses a file, a path outside, a protected path and input of the wrong kind", async () => {
    const { context } = await createTempCheckout({ "a.txt": "" });
    const tool: AiTool = createListFilesTool(context);

    expect(await tool.run({ path: "a.txt" })).toEqual({
      text: "That path is not a folder. Use read_file for a file.",
      isRefused: true,
    });
    expect((await tool.run({ path: "../" })).text).toBe(PATH_REFUSALS.outside);
    expect((await tool.run({ path: ".git" })).text).toBe(PATH_REFUSALS.protected);
    expect((await tool.run({ path: 3 })).text).toBe(INVALID_INPUT);
    expect((await tool.run("src")).text).toBe(INVALID_INPUT);
  });

  it("sorts names the same way everywhere", () => {
    const names = [{ name: "b" }, { name: "a" }, { name: "B" }, { name: "a" }];

    expect(names.sort(byName).map((entry) => entry.name)).toEqual(["B", "a", "a", "b"]);
  });
});
