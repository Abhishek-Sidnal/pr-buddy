import { z } from "zod";
import {
  MAX_BODY_LENGTH,
  MAX_FILES,
  MAX_PATCH_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_TOTAL_PATCH_LENGTH,
} from "../limits.js";
import type { DeepReadonly } from "../utils/deep-freeze.js";
import { repoPathSchema } from "./repo-path.js";

export const FILE_STATUSES = ["added", "modified", "removed", "renamed", "copied"] as const;

const STATUSES_WITH_PREVIOUS_PATH: ReadonlySet<string> = new Set(["renamed", "copied"]);

const commitShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "must be a full lowercase hexadecimal commit SHA");

const lineCountSchema = z.number().int().min(0);

export const changedFileSchema = z
  .strictObject({
    path: repoPathSchema,
    status: z.enum(FILE_STATUSES),
    previousPath: repoPathSchema.optional(),
    additions: lineCountSchema,
    deletions: lineCountSchema,
    /** Unified-diff hunks. Absent for binary files and files too large to diff. */
    patch: z.string().max(MAX_PATCH_LENGTH).optional(),
  })
  .superRefine((file, ctx) => {
    const needsPreviousPath = STATUSES_WITH_PREVIOUS_PATH.has(file.status);
    if (needsPreviousPath && file.previousPath === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["previousPath"],
        message: `is required when status is "${file.status}"`,
      });
    }
    if (!needsPreviousPath && file.previousPath !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["previousPath"],
        message: `is not allowed when status is "${file.status}"`,
      });
    }
  });

export const pullRequestSchema = z.strictObject({
  number: z.number().int().min(1),
  title: z.string().max(MAX_TITLE_LENGTH),
  /** `null` when the pull request has no description. */
  body: z.string().max(MAX_BODY_LENGTH).nullable(),
  baseSha: commitShaSchema,
  headSha: commitShaSchema,
});

export const reviewContextSchema = z
  .strictObject({
    pullRequest: pullRequestSchema,
    files: z.array(changedFileSchema).max(MAX_FILES),
  })
  .superRefine((context, ctx) => {
    const seen = new Set<string>();
    context.files.forEach((file, index) => {
      if (seen.has(file.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: "must be unique within the pull request",
        });
      }
      seen.add(file.path);
    });

    const totalPatchLength = context.files.reduce(
      (total, file) => total + (file.patch?.length ?? 0),
      0,
    );
    if (totalPatchLength > MAX_TOTAL_PATCH_LENGTH) {
      ctx.addIssue({
        code: "custom",
        path: ["files"],
        message: `patches must not total more than ${MAX_TOTAL_PATCH_LENGTH} characters`,
      });
    }
  });

export type FileStatus = (typeof FILE_STATUSES)[number];
export type ChangedFile = DeepReadonly<z.infer<typeof changedFileSchema>>;
export type PullRequest = DeepReadonly<z.infer<typeof pullRequestSchema>>;
export type ReviewContext = DeepReadonly<z.infer<typeof reviewContextSchema>>;
