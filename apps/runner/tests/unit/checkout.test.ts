import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_TOOL_FILE_BYTES, MAX_TOOL_PATH_LENGTH } from "../../src/limits.js";
import {
  isProtectedPath,
  openCheckout,
  PATH_REFUSALS,
  readTextFile,
  resolveInCheckout,
  type PathRefusal,
} from "../../src/tools/checkout.js";
import {
  CHECKOUT_HEAD_SHA,
  createTempCheckout,
  removeTempCheckouts,
} from "../helpers/temp-checkout.js";

afterEach(removeTempCheckouts);

describe("opening the checkout", () => {
  it("opens a checkout that is at the pull request's head commit", async () => {
    const { root } = await createTempCheckout();

    expect(await openCheckout(root, CHECKOUT_HEAD_SHA)).toEqual({ ok: true, checkout: { root } });
  });

  it("reports the folder with its links resolved", async () => {
    const { root } = await createTempCheckout();
    const link = `${root}-link`;
    await symlink(root, link);
    try {
      expect(await openCheckout(link, CHECKOUT_HEAD_SHA)).toEqual({
        ok: true,
        checkout: { root },
      });
    } finally {
      await rm(link);
    }
  });

  it.each([undefined, "", "/nonexistent/pr-buddy"])("finds no checkout at %j", async (path) => {
    expect(await openCheckout(path, CHECKOUT_HEAD_SHA)).toEqual({
      ok: false,
      problem: "missing",
    });
  });

  it("finds no checkout in a folder without Git's data", async () => {
    const { root } = await createTempCheckout();
    await rm(join(root, ".git"), { recursive: true });

    expect(await openCheckout(root, CHECKOUT_HEAD_SHA)).toEqual({ ok: false, problem: "missing" });
  });

  it("finds no checkout when .git is a file, as in a worktree", async () => {
    const { root } = await createTempCheckout();
    await rm(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git"), "gitdir: /elsewhere\n");

    expect(await openCheckout(root, CHECKOUT_HEAD_SHA)).toEqual({ ok: false, problem: "missing" });
  });

  it("does not follow a link in place of HEAD", async () => {
    const { root, write } = await createTempCheckout();
    await write("real-head", CHECKOUT_HEAD_SHA);
    await rm(join(root, ".git/HEAD"));
    await symlink(join(root, "real-head"), join(root, ".git/HEAD"));

    expect(await openCheckout(root, CHECKOUT_HEAD_SHA)).toEqual({ ok: false, problem: "missing" });
  });

  it("does not read a HEAD that is too long to be one", async () => {
    const { root, write } = await createTempCheckout();
    await write(".git/HEAD", "b".repeat(10_000));

    expect(await openCheckout(root, CHECKOUT_HEAD_SHA)).toEqual({ ok: false, problem: "missing" });
  });

  it.each([
    ["a branch", "ref: refs/heads/main\n"],
    ["another commit, such as GitHub's merge commit", `${"c".repeat(40)}\n`],
    ["something that is not a commit", "not-a-commit\n"],
  ])("refuses a checkout that is at %s", async (_name, head) => {
    const { root, write } = await createTempCheckout();
    await write(".git/HEAD", head);

    expect(await openCheckout(root, CHECKOUT_HEAD_SHA)).toEqual({
      ok: false,
      problem: "not-head",
    });
  });
});

describe("resolving a path a model asked for", () => {
  it.each([
    ["src/a.ts", "src/a.ts"],
    ["./src//a.ts", "src/a.ts"],
    ["src/./a.ts", "src/a.ts"],
    ["src", "src"],
    ["src/", "src"],
    [".env.example", ".env.example"],
    ["", ""],
    [".", ""],
  ])("accepts %j as %j", async (requested, relativePath) => {
    const { root, context } = await createTempCheckout({
      "src/a.ts": "one\n",
      ".env.example": "KEY=\n",
    });

    expect(await resolveInCheckout(context.checkout, requested)).toEqual({
      ok: true,
      relativePath,
      absolutePath: relativePath === "" ? root : join(root, relativePath),
    });
  });

  it.each<[string, PathRefusal]>([
    ["x".repeat(MAX_TOOL_PATH_LENGTH + 1), "invalid"],
    ["src/a\0.ts", "invalid"],
    ["src\\a.ts", "invalid"],
    ["/etc/passwd", "outside"],
    ["/proc/self/environ", "outside"],
    ["..", "outside"],
    ["../outside.txt", "outside"],
    ["src/../../outside.txt", "outside"],
    ["src/..", "outside"],
    [".git/config", "protected"],
    [".git", "protected"],
    ["vendor/lib/.git/HEAD", "protected"],
    [".GIT/config", "protected"],
    [".env", "protected"],
    ["config/.ENV", "protected"],
    ["certs/server.pem", "protected"],
    ["deploy/id_rsa", "protected"],
    ["package-lock.json", "protected"],
    ["src/missing.ts", "not-found"],
    ["src/a.ts/below", "not-found"],
  ])("refuses %j as %s", async (requested, refusal) => {
    const { context } = await createTempCheckout({
      "src/a.ts": "one\n",
      ".env": "SECRET-CANARY\n",
      "package-lock.json": "{}\n",
    });

    expect(await resolveInCheckout(context.checkout, requested)).toEqual({ ok: false, refusal });
  });

  it("refuses a link to a file outside the checkout", async () => {
    const { root, context } = await createTempCheckout();
    await symlink("/proc/self/environ", join(root, "notes.txt"));

    expect(await resolveInCheckout(context.checkout, "notes.txt")).toEqual({
      ok: false,
      refusal: "link",
    });
  });

  it("refuses a link to a file inside the checkout as well", async () => {
    const { root, context } = await createTempCheckout({ ".env": "SECRET-CANARY\n" });
    await symlink(join(root, ".env"), join(root, "settings.txt"));

    expect(await resolveInCheckout(context.checkout, "settings.txt")).toEqual({
      ok: false,
      refusal: "link",
    });
  });

  it("refuses a path that goes through a linked folder", async () => {
    const { root, context } = await createTempCheckout();
    await symlink("/etc", join(root, "system"));

    expect(await resolveInCheckout(context.checkout, "system/hostname")).toEqual({
      ok: false,
      refusal: "link",
    });
  });

  it("treats a link that points nowhere as nothing", async () => {
    const { root, context } = await createTempCheckout();
    await symlink(join(root, "gone"), join(root, "dangling"));

    expect(await resolveInCheckout(context.checkout, "dangling")).toEqual({
      ok: false,
      refusal: "not-found",
    });
  });

  it("has fixed words for every refusal, none of which repeats a path", () => {
    for (const text of Object.values(PATH_REFUSALS)) {
      expect(text).toMatch(/\.$/);
      expect(text).not.toContain("/");
    }
  });
});

describe("the names that are closed to the tools", () => {
  it.each([".git", ".git/HEAD", "a/.Git/b", ".env", "A/.ENV.PRODUCTION", "yarn.lock", "x.KEY"])(
    "protects %j",
    (path) => {
      expect(isProtectedPath(path)).toBe(true);
    },
  );

  it.each(["src/a.ts", ".github/workflows/ci.yml", ".gitignore", ".env.example", "git/x", ""])(
    "leaves %j open",
    (path) => {
      expect(isProtectedPath(path)).toBe(false);
    },
  );
});

describe("reading a file as lines", () => {
  it("numbers lines as Git does, with or without a final line break", async () => {
    const { root } = await createTempCheckout({
      "with.txt": "one\ntwo\n",
      "without.txt": "one\ntwo",
      "blank-end.txt": "one\n\n",
    });

    expect(await readTextFile(join(root, "with.txt"))).toEqual({
      ok: true,
      lines: ["one", "two"],
      byteLength: 8,
    });
    expect(await readTextFile(join(root, "without.txt"))).toMatchObject({ lines: ["one", "two"] });
    expect(await readTextFile(join(root, "blank-end.txt"))).toMatchObject({ lines: ["one", ""] });
  });

  it("drops the carriage return of a Windows line ending", async () => {
    const { root } = await createTempCheckout({ "crlf.txt": "one\r\ntwo\r\n" });

    expect(await readTextFile(join(root, "crlf.txt"))).toMatchObject({ lines: ["one", "two"] });
  });

  it("reads an empty file as no lines", async () => {
    const { root } = await createTempCheckout({ "empty.txt": "" });

    expect(await readTextFile(join(root, "empty.txt"))).toEqual({
      ok: true,
      lines: [],
      byteLength: 0,
    });
  });

  it("refuses a folder, a file that is too large and a file that is not text", async () => {
    const { root } = await createTempCheckout({
      "large.txt": "x".repeat(MAX_TOOL_FILE_BYTES + 1),
      "limit.txt": "x".repeat(MAX_TOOL_FILE_BYTES),
      "image.png": new Uint8Array([137, 80, 78, 71, 0, 1, 2]),
    });
    await mkdir(join(root, "folder"));

    expect(await readTextFile(join(root, "folder"))).toEqual({ ok: false, refusal: "not-a-file" });
    expect(await readTextFile(join(root, "large.txt"))).toEqual({
      ok: false,
      refusal: "too-large",
    });
    expect(await readTextFile(join(root, "limit.txt"))).toMatchObject({ ok: true });
    expect(await readTextFile(join(root, "image.png"))).toEqual({ ok: false, refusal: "binary" });
  });
});
