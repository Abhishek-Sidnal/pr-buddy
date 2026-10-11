import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isNeverSentPath } from "@pr-buddy/ai-reviewer";
import { MAX_HEAD_FILE_BYTES, MAX_TOOL_FILE_BYTES, MAX_TOOL_PATH_LENGTH } from "../limits.js";

/**
 * The repository's files on the runner, at the pull request's head commit. Everything in it is
 * untrusted. It is read and never executed, and it is reached only through this module.
 */
export interface Checkout {
  /** The absolute path of the folder, with every symbolic link in it resolved. */
  readonly root: string;
}

export type CheckoutProblem =
  /** There is no checkout: the workflow has no checkout step, or the folder is not one. */
  | "missing"
  /** The checkout is at another commit than the pull request's head, such as the merge commit. */
  | "not-head";

export type OpenedCheckout =
  | { readonly ok: true; readonly checkout: Checkout }
  | { readonly ok: false; readonly problem: CheckoutProblem };

const COMMIT_ID = /^[0-9a-f]{40}$/;
const GIT_FOLDER = ".git";

/**
 * Opens the checkout, if it is at `headSha`. Line numbers in a finding are those of the head
 * commit, so a checkout of anything else, such as GitHub's merge commit, would let a model
 * cite lines that do not match the diff. The commit is read from `.git/HEAD` as a file: no
 * `git` is run.
 */
export async function openCheckout(
  path: string | undefined,
  headSha: string,
): Promise<OpenedCheckout> {
  if (path === undefined || path === "") {
    return { ok: false, problem: "missing" };
  }
  let root: string;
  let head: string;
  try {
    root = await realpath(path);
    const gitFolder = await lstat(join(root, GIT_FOLDER));
    const headFile = await lstat(join(root, GIT_FOLDER, "HEAD"));
    if (!gitFolder.isDirectory() || !headFile.isFile() || headFile.size > MAX_HEAD_FILE_BYTES) {
      return { ok: false, problem: "missing" };
    }
    head = (await readFile(join(root, GIT_FOLDER, "HEAD"), "utf8")).trim();
  } catch {
    return { ok: false, problem: "missing" };
  }
  // A branch checkout holds "ref: refs/heads/…" here. Only a commit named outright counts.
  if (!COMMIT_ID.test(head) || head !== headSha) {
    return { ok: false, problem: "not-head" };
  }
  return { ok: true, checkout: { root } };
}

export type PathRefusal =
  /** Not a path this module handles: empty of meaning, too long, or in another notation. */
  | "invalid"
  /** It would leave the checkout. */
  | "outside"
  /** Its name says it may hold credentials, or it is Git's own data. */
  | "protected"
  | "not-found"
  /** It is, or goes through, a symbolic link. */
  | "link";

export type ResolvedPath =
  | {
      readonly ok: true;
      /** Relative to the root, with forward slashes; empty for the root itself. */
      readonly relativePath: string;
      readonly absolutePath: string;
    }
  | { readonly ok: false; readonly refusal: PathRefusal };

/** What to tell a model about a refused path. Fixed text: it never repeats the path. */
export const PATH_REFUSALS: Readonly<Record<PathRefusal, string>> = {
  invalid:
    "That is not a usable path. Give a path relative to the repository's root, with forward slashes.",
  outside: "That path leaves the repository. Only what is inside it can be read.",
  protected:
    "That path is not available to a review: its name says it may hold credentials, or it is a lockfile or Git's own data.",
  "not-found": "Nothing exists at that path.",
  link: "That path is, or goes through, a symbolic link. Links are not followed.",
};

/**
 * Whether a path inside the checkout is closed to the tools. Names are compared in lower case
 * as well, so that a file system that ignores case cannot be used to get around the policy.
 */
export function isProtectedPath(relativePath: string): boolean {
  const lowered = relativePath.toLowerCase();
  return (
    lowered.split("/").includes(GIT_FOLDER) ||
    isNeverSentPath(relativePath) ||
    isNeverSentPath(lowered)
  );
}

/**
 * Turns a path a model asked for into one inside the checkout, or refuses it.
 *
 * `..` is refused outright instead of being resolved, and a symbolic link is refused wherever
 * it points: a link is the one way a file in the checkout could stand for a file outside it,
 * such as the process's own environment.
 */
export async function resolveInCheckout(
  checkout: Checkout,
  requested: string,
): Promise<ResolvedPath> {
  if (
    requested.length > MAX_TOOL_PATH_LENGTH ||
    requested.includes("\0") ||
    requested.includes("\\")
  ) {
    return { ok: false, refusal: "invalid" };
  }
  if (requested.startsWith("/")) {
    return { ok: false, refusal: "outside" };
  }
  const segments = requested.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    return { ok: false, refusal: "outside" };
  }
  const relativePath = segments.join("/");
  if (isProtectedPath(relativePath)) {
    return { ok: false, refusal: "protected" };
  }

  const absolutePath = join(checkout.root, ...segments);
  let real: string;
  try {
    real = await realpath(absolutePath);
  } catch {
    return { ok: false, refusal: "not-found" };
  }
  if (real !== absolutePath) {
    return { ok: false, refusal: "link" };
  }
  return { ok: true, relativePath, absolutePath };
}

export type TextRefusal = "not-a-file" | "too-large" | "binary";

export type TextFile =
  | { readonly ok: true; readonly lines: readonly string[]; readonly byteLength: number }
  | { readonly ok: false; readonly refusal: TextRefusal };

export const TEXT_REFUSALS: Readonly<Record<TextRefusal, string>> = {
  "not-a-file": "That path is not a file. Use list_files for a folder.",
  "too-large": "That file is too large to read in a review.",
  binary: "That file is not text.",
};

/**
 * Reads a file of the checkout as lines, numbered as Git numbers them. `absolutePath` must come
 * from `resolveInCheckout`.
 */
export async function readTextFile(absolutePath: string): Promise<TextFile> {
  const stats = await lstat(absolutePath);
  if (!stats.isFile()) {
    return { ok: false, refusal: "not-a-file" };
  }
  if (stats.size > MAX_TOOL_FILE_BYTES) {
    return { ok: false, refusal: "too-large" };
  }
  const bytes = await readFile(absolutePath);
  if (bytes.includes(0)) {
    return { ok: false, refusal: "binary" };
  }
  const lines = bytes.toString("utf8").split("\n");
  // A final line break ends the last line; it does not start an empty one.
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return {
    ok: true,
    lines: lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)),
    byteLength: bytes.length,
  };
}
