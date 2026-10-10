import { describe, expect, it } from "vitest";
import { hasContentChanges } from "../../../src/context/changed-file.js";
import type { ChangedFile } from "../../../src/context/context.schema.js";
import { parseReviewContext } from "../../../src/context/parse-context.js";
import { describeUnsafeRepoPath } from "../../../src/context/repo-path.js";
import { InvalidContextError } from "../../../src/errors.js";
import {
  MAX_BODY_LENGTH,
  MAX_FILES,
  MAX_PATCH_LENGTH,
  MAX_PATH_LENGTH,
} from "../../../src/limits.js";
import { buildContext, buildFile, buildFiles, buildPullRequest } from "../../helpers/builders.js";

/** Parses input that is expected to be invalid and returns the reported issues. */
function issuesOf(input: unknown): readonly string[] {
  try {
    parseReviewContext(input);
  } catch (error) {
    if (error instanceof InvalidContextError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("Expected the context to be rejected.");
}

describe("describeUnsafeRepoPath", () => {
  it.each(["src/index.ts", "README.md", ".github/workflows/ci.yml", "a/b c/d-e_f.ts", "..hidden"])(
    "accepts %s",
    (path) => {
      expect(describeUnsafeRepoPath(path)).toBeUndefined();
    },
  );

  it.each([
    ["an absolute path", "/etc/passwd"],
    ["parent traversal", "../secrets.txt"],
    ["nested parent traversal", "src/../../secrets.txt"],
    ["a current-directory segment", "./src/index.ts"],
    ["a backslash", "src\\index.ts"],
    ["an empty segment", "src//index.ts"],
    ["a trailing slash", "src/"],
    ["a null byte", "src/index.ts\u0000.png"],
    ["a newline", "src/index.ts\nmalicious"],
    ["a delete character", "src/\u007findex.ts"],
  ])("rejects %s", (_name, path) => {
    expect(describeUnsafeRepoPath(path)).toBeTypeOf("string");
  });
});

describe("parseReviewContext", () => {
  it("accepts a valid context", () => {
    const context = parseReviewContext(buildContext());

    expect(context.pullRequest.number).toBe(1);
    expect(context.files).toHaveLength(1);
  });

  it("accepts a pull request with no description and no files", () => {
    const context = parseReviewContext(
      buildContext({ pullRequest: { body: null, title: "" }, files: [] }),
    );

    expect(context.pullRequest.body).toBeNull();
    expect(context.files).toEqual([]);
  });

  it("accepts a 64-character SHA-256 commit ID", () => {
    const sha = "c".repeat(64);

    expect(() => parseReviewContext(buildContext({ pullRequest: { headSha: sha } }))).not.toThrow();
  });

  it("accepts renamed and copied files with a previous path", () => {
    const files = [
      buildFile({ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" }),
      buildFile({ path: "src/copy.ts", previousPath: "src/original.ts", status: "copied" }),
    ];

    expect(parseReviewContext(buildContext({ files })).files).toHaveLength(2);
  });

  it("returns a deeply frozen copy and leaves the input untouched", () => {
    const input = buildContext();
    const context = parseReviewContext(input);

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.pullRequest)).toBe(true);
    expect(Object.isFrozen(context.files)).toBe(true);
    expect(Object.isFrozen(context.files[0])).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(context).not.toBe(input);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "not a context"],
    ["a number", 7],
    ["an array", []],
    ["an empty object", {}],
  ])("rejects %s", (_name, input) => {
    expect(() => parseReviewContext(input)).toThrow(InvalidContextError);
  });

  it("rejects unknown fields at every level", () => {
    const context = buildContext();

    expect(issuesOf({ ...context, extra: true }).join()).toContain("extra");
    expect(
      issuesOf({ ...context, pullRequest: { ...context.pullRequest, author: "x" } }).join(),
    ).toContain("author");
    expect(issuesOf({ ...context, files: [{ ...buildFile(), sha: "x" }] }).join()).toContain("sha");
  });

  it("reports the path of each invalid field", () => {
    const issues = issuesOf({
      pullRequest: { ...buildPullRequest(), number: 0, headSha: "abc123" },
      files: [{ ...buildFile(), additions: -1 }],
    });

    expect(issues.some((issue) => issue.startsWith("pullRequest.number:"))).toBe(true);
    expect(issues.some((issue) => issue.startsWith("pullRequest.headSha:"))).toBe(true);
    expect(issues.some((issue) => issue.startsWith("files.0.additions:"))).toBe(true);
  });

  it("does not echo input values in error messages", () => {
    const secret = "sk-live-do-not-leak";

    const issues = issuesOf(buildContext({ pullRequest: { headSha: secret } }));

    expect(issues.join()).not.toContain(secret);
  });

  it.each([
    ["an uppercase SHA", { baseSha: "A".repeat(40) }],
    ["a short SHA", { baseSha: "abc1234" }],
    ["a fractional number", { number: 1.5 }],
    ["a numeric title", { title: 5 }],
    ["an undefined body", { body: undefined }],
    ["an oversized body", { body: "x".repeat(MAX_BODY_LENGTH + 1) }],
  ])("rejects a pull request with %s", (_name, overrides) => {
    const input = { pullRequest: { ...buildPullRequest(), ...overrides }, files: [] };

    expect(() => parseReviewContext(input)).toThrow(InvalidContextError);
  });

  it.each([
    ["path traversal", { path: "../../etc/passwd" }],
    ["an absolute path", { path: "/etc/passwd" }],
    ["an empty path", { path: "" }],
    ["an oversized path", { path: "a".repeat(MAX_PATH_LENGTH + 1) }],
    ["an unknown status", { status: "unchanged" }],
    ["negative deletions", { deletions: -3 }],
    ["fractional additions", { additions: 0.5 }],
    ["an oversized patch", { patch: "+".repeat(MAX_PATCH_LENGTH + 1) }],
    ["a non-string patch", { patch: 12 }],
    ["an unsafe previous path", { status: "renamed", previousPath: "../old.ts" }],
  ])("rejects a file with %s", (_name, overrides) => {
    const input = { pullRequest: buildPullRequest(), files: [{ ...buildFile(), ...overrides }] };

    expect(() => parseReviewContext(input)).toThrow(InvalidContextError);
  });

  it("requires a previous path for renamed and copied files", () => {
    const issues = issuesOf(buildContext({ files: [buildFile({ status: "renamed" })] }));

    expect(issues).toEqual(['files.0.previousPath: is required when status is "renamed"']);
  });

  it("forbids a previous path for other statuses", () => {
    const files = [buildFile({ status: "modified", previousPath: "src/old.ts" })];

    expect(issuesOf(buildContext({ files }))).toEqual([
      'files.0.previousPath: is not allowed when status is "modified"',
    ]);
  });

  it("rejects duplicate file paths", () => {
    const files = [buildFile({ path: "src/a.ts" }), buildFile({ path: "src/a.ts" })];

    expect(issuesOf(buildContext({ files }))).toEqual([
      "files.1.path: must be unique within the pull request",
    ]);
  });

  it("accepts the maximum number of files and rejects one more", () => {
    expect(() => parseReviewContext(buildContext({ files: buildFiles(MAX_FILES) }))).not.toThrow();
    expect(() => parseReviewContext(buildContext({ files: buildFiles(MAX_FILES + 1) }))).toThrow(
      InvalidContextError,
    );
  });
});

describe("hasContentChanges", () => {
  function parse(overrides: Parameters<typeof buildFile>[0]): ChangedFile {
    const [file] = parseReviewContext(buildContext({ files: [buildFile(overrides)] })).files;
    if (file === undefined) {
      throw new Error("Expected one file.");
    }
    return file;
  }

  it("is true for edited and added files", () => {
    expect(hasContentChanges(parse({ status: "modified", additions: 2, deletions: 0 }))).toBe(true);
    expect(hasContentChanges(parse({ status: "added", additions: 5, deletions: 0 }))).toBe(true);
  });

  it("is false for removed files", () => {
    expect(hasContentChanges(parse({ status: "removed", additions: 0, deletions: 9 }))).toBe(false);
  });

  it("is false for a pure rename", () => {
    const file = parse({
      status: "renamed",
      previousPath: "src/old.ts",
      additions: 0,
      deletions: 0,
    });

    expect(hasContentChanges(file)).toBe(false);
  });
});
