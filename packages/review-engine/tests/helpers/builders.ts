import type { z } from "zod";
import {
  parseReviewContext,
  type changedFileSchema,
  type pullRequestSchema,
  type ReviewRule,
  type reviewContextSchema,
  type RuleOutput,
} from "../../src/index.js";

export type FileInput = z.input<typeof changedFileSchema>;
export type PullRequestInput = z.input<typeof pullRequestSchema>;
export type ContextInput = z.input<typeof reviewContextSchema>;

export const BASE_SHA = "a".repeat(40);
export const HEAD_SHA = "b".repeat(40);

export function buildFile(overrides: Partial<FileInput> = {}): FileInput {
  return { path: "src/index.ts", status: "modified", additions: 1, deletions: 1, ...overrides };
}

/** Builds `count` modified files named `<prefix>-<n>.ts`. */
export function buildFiles(count: number, prefix = "src/file"): FileInput[] {
  return Array.from({ length: count }, (_unused, index) =>
    buildFile({ path: `${prefix}-${index}.ts` }),
  );
}

export function buildPullRequest(overrides: Partial<PullRequestInput> = {}): PullRequestInput {
  return {
    number: 1,
    title: "Add a feature",
    body: "Adds a feature, explains why it is needed and describes how it was tested.",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    ...overrides,
  };
}

export function buildContext(
  overrides: { pullRequest?: Partial<PullRequestInput>; files?: FileInput[] } = {},
): ContextInput {
  return {
    pullRequest: buildPullRequest(overrides.pullRequest),
    files: overrides.files ?? [buildFile()],
  };
}

/** Runs one rule the way the engine does: validated context, options parsed by the rule. */
export async function runRuleWith<TOptionsSchema extends z.ZodType>(
  rule: ReviewRule<TOptionsSchema>,
  context: ContextInput,
  options: unknown = {},
): Promise<RuleOutput> {
  return rule.run(parseReviewContext(context), rule.optionsSchema.parse(options));
}
