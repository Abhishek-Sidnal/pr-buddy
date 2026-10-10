import { parseReviewContext, type ChangedFile, type ReviewContext } from "@pr-buddy/review-engine";

/** A patch that adds the given lines to a new file, starting at line 1. */
export function addedPatch(...lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
}

export function addedFile(path: string, ...lines: string[]): ChangedFile {
  return {
    path,
    status: "added",
    additions: lines.length,
    deletions: 0,
    patch: addedPatch(...lines),
  };
}

export interface ContextOverrides {
  readonly title?: string;
  readonly body?: string | null;
  readonly files?: readonly ChangedFile[];
}

/** A validated context, as the review engine would hand it to the AI reviewer. */
export function contextWith(overrides: ContextOverrides = {}): ReviewContext {
  return parseReviewContext({
    pullRequest: {
      number: 7,
      title: overrides.title ?? "Add a loader",
      body: overrides.body === undefined ? "Loads the settings file." : overrides.body,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    files: overrides.files ?? [
      addedFile("src/loader.ts", "export function load() {", "  return read();", "}"),
    ],
  });
}

/** A reply in the form the model is asked for. */
export function reply(...findings: unknown[]): string {
  return JSON.stringify({ findings });
}
