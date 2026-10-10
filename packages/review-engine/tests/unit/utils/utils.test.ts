import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deepFreeze } from "../../../src/utils/deep-freeze.js";
import {
  createPathMatcher,
  expandBraces,
  globListSchema,
  globPatternSchema,
} from "../../../src/utils/glob.js";
import { extractMeaningfulText, stripHtmlComments } from "../../../src/utils/markdown.js";
import { pluralize, summarizeList, truncate } from "../../../src/utils/text.js";
import { TimeoutError, withTimeout } from "../../../src/utils/timeout.js";
import { formatZodIssues } from "../../../src/utils/zod-issues.js";
import {
  MAX_GLOB_EXPANSIONS,
  MAX_GLOB_LENGTH,
  MAX_GLOB_PATTERNS,
  MAX_ISSUE_LENGTH,
} from "../../../src/limits.js";

describe("createPathMatcher", () => {
  it("matches files at any depth, including the repository root", () => {
    const matches = createPathMatcher(["**/*.test.ts"]);

    expect(matches("user.test.ts")).toBe(true);
    expect(matches("src/services/user.test.ts")).toBe(true);
    expect(matches("src/services/user.ts")).toBe(false);
  });

  it("matches when any pattern matches", () => {
    const matches = createPathMatcher(["docs/**", "**/*.md"]);

    expect(matches("docs/guide.txt")).toBe(true);
    expect(matches("README.md")).toBe(true);
    expect(matches("src/index.ts")).toBe(false);
  });

  it("supports brace alternatives", () => {
    const matches = createPathMatcher(["**/*.{test,spec}.{ts,tsx}"]);

    expect(matches("src/a.spec.tsx")).toBe(true);
    expect(matches("src/a.test.js")).toBe(false);
  });

  it("matches dotfiles and files in dot directories", () => {
    const matches = createPathMatcher(["**/*.yml"]);

    expect(matches(".github/workflows/ci.yml")).toBe(true);
  });

  it("treats a leading exclamation mark literally instead of negating", () => {
    const matches = createPathMatcher(["!src/**"]);

    expect(matches("docs/guide.md")).toBe(false);
  });

  it("matches nothing when there are no patterns", () => {
    expect(createPathMatcher([])("src/index.ts")).toBe(false);
  });

  it("keeps a single star within one path segment", () => {
    const matches = createPathMatcher(["src/*.ts"]);

    expect(matches("src/index.ts")).toBe(true);
    expect(matches("src/nested/index.ts")).toBe(false);
    expect(matches("index.ts")).toBe(false);
  });

  it("lets a double star stand for zero or more segments anywhere", () => {
    const matches = createPathMatcher(["src/**/index.ts"]);

    expect(matches("src/index.ts")).toBe(true);
    expect(matches("src/a/b/c/index.ts")).toBe(true);
    expect(matches("lib/src/index.ts")).toBe(false);
  });

  it("matches everything below a folder with a trailing double star", () => {
    const matches = createPathMatcher(["docs/**"]);

    expect(matches("docs/a/b.md")).toBe(true);
    expect(matches("documents/a.md")).toBe(false);
  });

  it("lets a trailing wildcard match nothing at all", () => {
    expect(createPathMatcher(["docs/**"])("docs")).toBe(true);
    expect(createPathMatcher(["src/index.ts*"])("src/index.ts")).toBe(true);
    expect(createPathMatcher(["src/**/**"])("src")).toBe(true);
  });

  it("matches exactly one character with a question mark", () => {
    const matches = createPathMatcher(["src/file-?.ts"]);

    expect(matches("src/file-1.ts")).toBe(true);
    expect(matches("src/file-10.ts")).toBe(false);
    expect(matches("src/file-.ts")).toBe(false);
  });

  it("matches several stars in one segment", () => {
    const matches = createPathMatcher(["**/*.stories.*"]);

    expect(matches("src/Button.stories.tsx")).toBe(true);
    expect(matches("src/Button.tsx")).toBe(false);
  });

  it("requires the whole path to match", () => {
    const matches = createPathMatcher(["src/index"]);

    expect(matches("src/index")).toBe(true);
    expect(matches("src/index.ts")).toBe(false);
    expect(matches("src")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(createPathMatcher(["README.md"])("readme.md")).toBe(false);
  });

  it("treats brackets and parentheses as literal characters", () => {
    const matches = createPathMatcher(["app/(shop)/[id]/page.tsx"]);

    expect(matches("app/(shop)/[id]/page.tsx")).toBe(true);
    expect(matches("app/(shop)/i/page.tsx")).toBe(false);
  });

  it("supports nested brace alternatives", () => {
    const matches = createPathMatcher(["src/{a,b/{c,d}}.ts"]);

    expect(matches("src/a.ts")).toBe(true);
    expect(matches("src/b/c.ts")).toBe(true);
    expect(matches("src/b/d.ts")).toBe(true);
    expect(matches("src/b.ts")).toBe(false);
  });

  it("treats three or more stars as a double star", () => {
    expect(createPathMatcher(["src/***"])("src/a/b.ts")).toBe(true);
  });

  it("throws for a pattern that was not validated", () => {
    expect(() => createPathMatcher(["src/{a,b"])).toThrow(RangeError);
  });

  it.each([
    ["many stars in one segment", `${"*a".repeat(40)}*b`, "a".repeat(1_024)],
    ["many double stars", `${"**/a/".repeat(40)}b`, "a/".repeat(511) + "a"],
    ["many question marks", `${"?".repeat(100)}*${"?".repeat(100)}b`, "a".repeat(1_024)],
  ])("rejects a hostile input quickly: %s", (_name, pattern, path) => {
    const startedAt = performance.now();

    expect(createPathMatcher([pattern])(path)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("expandBraces", () => {
  it("returns a pattern without braces unchanged", () => {
    expect(expandBraces("src/**/*.ts")).toEqual(["src/**/*.ts"]);
  });

  it("expands alternatives in the order written", () => {
    expect(expandBraces("a.{js,ts}")).toEqual(["a.js", "a.ts"]);
  });

  it("expands every combination of several groups", () => {
    expect(expandBraces("{a,b}.{x,y}")).toEqual(["a.x", "a.y", "b.x", "b.y"]);
  });

  it("allows empty and single alternatives", () => {
    expect(expandBraces("file{,.min}.js")).toEqual(["file.js", "file.min.js"]);
    expect(expandBraces("{only}")).toEqual(["only"]);
  });

  it.each(["{a,b", "a,b}", "}{", "{a,{b,c}", "a}b{c"])(
    "rejects unbalanced braces in %s",
    (pattern) => {
      expect(expandBraces(pattern)).toBeUndefined();
    },
  );

  it("rejects a pattern that expands to too many patterns", () => {
    const atLimit = "{a,b,c,d}{a,b,c,d}{a,b,c,d}";
    const overLimit = `${atLimit}{a,b}`;

    expect(expandBraces(atLimit)).toHaveLength(MAX_GLOB_EXPANSIONS);
    expect(expandBraces(overLimit)).toBeUndefined();
  });
});

describe("glob schemas", () => {
  it("accepts ordinary patterns", () => {
    expect(globListSchema.safeParse(["src/**", "**/*.ts"]).success).toBe(true);
  });

  it.each([
    ["an empty pattern", ""],
    ["a pattern that is too long", "a".repeat(MAX_GLOB_LENGTH + 1)],
    ["a non-string", 42],
    ["unbalanced braces", "src/*.{ts,tsx"],
    ["too many brace combinations", "{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b}"],
  ])("rejects %s", (_name, pattern) => {
    expect(globPatternSchema.safeParse(pattern).success).toBe(false);
  });

  it("rejects too many patterns", () => {
    const patterns = Array.from({ length: MAX_GLOB_PATTERNS + 1 }, () => "**/*.ts");

    expect(globListSchema.safeParse(patterns).success).toBe(false);
  });
});

describe("stripHtmlComments", () => {
  it("removes single and multi-line comments", () => {
    expect(stripHtmlComments("a<!-- one -->b<!--\ntwo\n-->c")).toBe("abc");
  });

  it("returns text without comments unchanged", () => {
    expect(stripHtmlComments("no comments here")).toBe("no comments here");
  });

  it("drops everything after an unterminated comment", () => {
    expect(stripHtmlComments("kept <!-- never closed")).toBe("kept ");
  });

  it("handles a very long run of comment openers in linear time", () => {
    const hostile = "<!--".repeat(50_000);

    expect(stripHtmlComments(hostile)).toBe("");
  });
});

describe("extractMeaningfulText", () => {
  it("drops template headings and comments and collapses whitespace", () => {
    const body = "## What\n<!-- describe -->\n\nFixes   the\tlogin bug.\n\n### Notes\n";

    expect(extractMeaningfulText(body)).toBe("Fixes the login bug.");
  });

  it("keeps lines that only look like headings", () => {
    expect(extractMeaningfulText("#123 is fixed\n#hashtag")).toBe("#123 is fixed #hashtag");
  });

  it("returns an empty string for whitespace", () => {
    expect(extractMeaningfulText(" \n\t\r\n ")).toBe("");
  });
});

describe("text helpers", () => {
  it("truncates with an ellipsis and never exceeds the limit", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 6)).toBe("abcdef");
    expect(truncate("abcdef", 0)).toHaveLength(1);
  });

  it("pluralizes by count", () => {
    expect(pluralize(1, "file")).toBe("1 file");
    expect(pluralize(0, "file")).toBe("0 files");
    expect(pluralize(2, "entry", "entries")).toBe("2 entries");
  });

  it("summarizes long lists", () => {
    expect(summarizeList(["a", "b", "c"], 2)).toBe("a, b (and 1 more)");
    expect(summarizeList(["a", "b"], 2)).toBe("a, b");
    expect(summarizeList([], 2)).toBe("");
  });
});

describe("deepFreeze", () => {
  it("freezes nested objects and arrays", () => {
    const value = deepFreeze({ list: [{ name: "a" }], nested: { count: 1 } });

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.list)).toBe(true);
    expect(Object.isFrozen(value.list[0])).toBe(true);
    expect(Object.isFrozen(value.nested)).toBe(true);
  });

  it("returns primitives unchanged", () => {
    expect(deepFreeze("text")).toBe("text");
    expect(deepFreeze(7)).toBe(7);
    expect(deepFreeze(null)).toBeNull();
  });
});

describe("withTimeout", () => {
  it("resolves with the value of a synchronous operation", async () => {
    await expect(withTimeout(() => 42, 1_000)).resolves.toBe(42);
  });

  it("resolves with the value of an asynchronous operation", async () => {
    await expect(withTimeout(() => Promise.resolve("done"), 1_000)).resolves.toBe("done");
  });

  it("rejects when the operation throws synchronously", async () => {
    const operation = (): never => {
      throw new Error("boom");
    };

    await expect(withTimeout(operation, 1_000)).rejects.toThrow("boom");
  });

  it("rejects with TimeoutError when the operation does not settle in time", async () => {
    const never = new Promise<never>(() => undefined);

    await expect(withTimeout(() => never, 10)).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("formatZodIssues", () => {
  const schema = z.strictObject({ name: z.string(), tags: z.array(z.string()) });

  it("formats each issue with its path", () => {
    const result = schema.safeParse({ name: 1, tags: ["ok", 2] });

    expect(result.success).toBe(false);
    const issues = result.success ? [] : formatZodIssues(result.error);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^name: /);
    expect(issues[1]).toMatch(/^tags\.1: /);
  });

  it("applies a path prefix", () => {
    const result = schema.safeParse({ name: 1, tags: [] });

    const issues = result.success ? [] : formatZodIssues(result.error, "rules.example.options");
    expect(issues[0]).toMatch(/^rules\.example\.options\.name: /);
  });

  it("bounds the length of an issue that quotes a field name from the input", () => {
    const result = schema.safeParse({ name: "a", tags: [], ["x".repeat(5_000)]: true });

    const issues = result.success ? [] : formatZodIssues(result.error);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.length).toBeLessThanOrEqual(MAX_ISSUE_LENGTH);
  });

  it("uses the prefix alone for a root-level issue", () => {
    const result = z.number().safeParse("text");

    const issues = result.success ? [] : formatZodIssues(result.error, "ruleTimeoutMs");
    expect(issues[0]).toMatch(/^ruleTimeoutMs: /);
    expect(result.success ? [] : formatZodIssues(result.error)).toHaveLength(1);
  });
});
