import {
  MAX_BODY_LENGTH,
  MAX_PATCH_LENGTH,
  MAX_TOTAL_PATCH_LENGTH,
  MAX_TITLE_LENGTH,
  parseReviewContext,
} from "@pr-buddy/review-engine";
import { describe, expect, it } from "vitest";
import type { PullRequestFile, PullRequestSnapshot } from "../../src/api/repository-client.js";
import { toReviewContext } from "../../src/mapping/to-review-context.js";

function buildPullRequest(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 12,
    title: "Add a feature",
    body: "Adds a feature and explains why.",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    state: "open",
    isDraft: false,
    changedFileCount: 1,
    ...overrides,
  };
}

function buildFile(overrides: Partial<PullRequestFile> = {}): PullRequestFile {
  return { path: "src/index.ts", status: "modified", additions: 2, deletions: 1, ...overrides };
}

const map = (files: PullRequestFile[]): ReturnType<typeof toReviewContext> =>
  toReviewContext(buildPullRequest(), files);

describe("toReviewContext", () => {
  it("maps the pull request and its files", () => {
    const patch = "@@ -1 +1 @@\n-a\n+b";

    expect(map([buildFile({ patch })])).toEqual({
      context: {
        pullRequest: {
          number: 12,
          title: "Add a feature",
          body: "Adds a feature and explains why.",
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
        },
        files: [{ path: "src/index.ts", status: "modified", additions: 2, deletions: 1, patch }],
      },
      skippedFileCount: 0,
      omittedPatchCount: 0,
    });
  });

  it.each(["added", "removed", "modified"])("keeps the %s status", (status) => {
    expect(map([buildFile({ status })]).context.files[0]?.status).toBe(status);
  });

  it("treats GitHub's changed status as modified", () => {
    expect(map([buildFile({ status: "changed" })]).context.files[0]?.status).toBe("modified");
  });

  it.each(["renamed", "copied"])("keeps the previous path of a %s file", (status) => {
    const [file] = map([buildFile({ status, previousPath: "src/old.ts" })]).context.files;

    expect(file).toMatchObject({ status, previousPath: "src/old.ts" });
  });

  it("treats a rename without a previous path as an edit", () => {
    const [file] = map([buildFile({ status: "renamed" })]).context.files;

    expect(file?.status).toBe("modified");
    expect(file).not.toHaveProperty("previousPath");
  });

  it("drops a previous path from a file that was not renamed or copied", () => {
    const [file] = map([buildFile({ status: "modified", previousPath: "src/old.ts" })]).context
      .files;

    expect(file).not.toHaveProperty("previousPath");
  });

  it("drops unchanged files without counting them as skipped", () => {
    const mapped = map([buildFile({ status: "unchanged" }), buildFile({ path: "src/kept.ts" })]);

    expect(mapped.context.files.map((file) => file.path)).toEqual(["src/kept.ts"]);
    expect(mapped.skippedFileCount).toBe(0);
  });

  it.each([
    ["path traversal", { path: "../../etc/passwd" }],
    ["an absolute path", { path: "/etc/passwd" }],
    ["a backslash", { path: "src\\index.ts" }],
    ["a control character", { path: "src/index.ts\u0000" }],
    ["an unknown status", { status: "teleported" }],
    ["a negative line count", { additions: -1 }],
    ["an unsafe previous path", { status: "renamed", previousPath: "../old.ts" }],
  ])("skips and counts a file with %s", (_name, overrides) => {
    const mapped = map([buildFile(overrides), buildFile({ path: "src/kept.ts" })]);

    expect(mapped.context.files.map((file) => file.path)).toEqual(["src/kept.ts"]);
    expect(mapped.skippedFileCount).toBe(1);
  });

  it("skips and counts a repeated path", () => {
    const mapped = map([buildFile(), buildFile()]);

    expect(mapped.context.files).toHaveLength(1);
    expect(mapped.skippedFileCount).toBe(1);
  });

  it("keeps a file whose patch is too large, without the patch, and counts it", () => {
    const mapped = map([buildFile({ patch: "+".repeat(MAX_PATCH_LENGTH + 1) })]);

    expect(mapped.context.files[0]?.path).toBe("src/index.ts");
    expect(mapped.context.files[0]).not.toHaveProperty("patch");
    expect(mapped.omittedPatchCount).toBe(1);
    expect(mapped.skippedFileCount).toBe(0);
  });

  it("counts a patch that the client already left out", () => {
    const mapped = map([buildFile({ patchOmitted: true })]);

    expect(mapped.context.files).toHaveLength(1);
    expect(mapped.omittedPatchCount).toBe(1);
  });

  it("does not count a file that never had a patch", () => {
    expect(map([buildFile()]).omittedPatchCount).toBe(0);
  });

  it("stops keeping patches once the total budget is spent, but keeps every file", () => {
    const fullPatch = "+".repeat(MAX_PATCH_LENGTH);
    const patchesThatFit = MAX_TOTAL_PATCH_LENGTH / MAX_PATCH_LENGTH;
    const files = Array.from({ length: patchesThatFit + 3 }, (_unused, index) =>
      buildFile({ path: `src/big-${index}.ts`, patch: fullPatch }),
    );

    const mapped = map(files);

    const kept = mapped.context.files.filter((file) => file.patch !== undefined);
    expect(mapped.context.files).toHaveLength(patchesThatFit + 3);
    expect(kept).toHaveLength(patchesThatFit);
    expect(mapped.omittedPatchCount).toBe(3);
    expect(() => parseReviewContext(mapped.context)).not.toThrow();
  });

  it("still keeps a small patch after a large one did not fit", () => {
    const files = [
      ...Array.from({ length: 9 }, (_unused, index) =>
        buildFile({ path: `src/big-${index}.ts`, patch: "+".repeat(MAX_PATCH_LENGTH) }),
      ),
      buildFile({ path: "src/almost.ts", patch: "+".repeat(MAX_PATCH_LENGTH - 10) }),
      buildFile({ path: "src/too-much.ts", patch: "+".repeat(100) }),
      buildFile({ path: "src/small.ts", patch: "+tiny" }),
    ];

    const mapped = map(files);

    expect(mapped.context.files.at(-2)).not.toHaveProperty("patch");
    expect(mapped.context.files.at(-1)).toMatchObject({ path: "src/small.ts", patch: "+tiny" });
    expect(mapped.omittedPatchCount).toBe(1);
  });

  it("keeps binary files, which have no patch", () => {
    const mapped = map([
      buildFile({ path: "logo.png", status: "added", additions: 0, deletions: 0 }),
    ]);

    expect(mapped.context.files).toEqual([
      { path: "logo.png", status: "added", additions: 0, deletions: 0 },
    ]);
  });

  it("keeps a missing description as null", () => {
    expect(
      toReviewContext(buildPullRequest({ body: null }), []).context.pullRequest.body,
    ).toBeNull();
  });

  it("truncates a title and a description that exceed the engine's limits", () => {
    const { pullRequest } = toReviewContext(
      buildPullRequest({
        title: "t".repeat(MAX_TITLE_LENGTH + 10),
        body: "b".repeat(MAX_BODY_LENGTH + 10),
      }),
      [],
    ).context;

    expect(pullRequest.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(pullRequest.body).toHaveLength(MAX_BODY_LENGTH);
  });

  it("always produces input the review engine accepts", () => {
    const files = [
      buildFile({ path: "src/a.ts", status: "added", patch: "@@ -0,0 +1 @@\n+a" }),
      buildFile({ path: "src/b.ts", status: "renamed", previousPath: "src/old-b.ts" }),
      buildFile({ path: "src/c.ts", status: "renamed" }),
      buildFile({ path: "src/d.ts", status: "changed" }),
      buildFile({ path: "../escape.ts" }),
      buildFile({ path: "src/e.ts", status: "unchanged" }),
      buildFile({ path: "src/f.bin", patch: "+".repeat(MAX_PATCH_LENGTH + 1) }),
    ];

    const { context } = toReviewContext(buildPullRequest({ body: null }), files);

    expect(() => parseReviewContext(context)).not.toThrow();
    expect(context.files).toHaveLength(5);
  });
});
