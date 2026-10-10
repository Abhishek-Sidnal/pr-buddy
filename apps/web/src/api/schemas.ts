import { z } from "zod";

/**
 * The shapes of the read API's answers. Every answer is parsed with one of these before it is
 * shown, so the types below describe what was checked, not what was hoped for.
 */

const count = z.number().int().min(0);

export const reviewStatusSchema = z.enum(["completed", "skipped", "failed"]);

export const repositoryRefSchema = z.object({
  id: z.number().int().positive(),
  owner: z.string(),
  name: z.string(),
});

export const reviewSummarySchema = z.object({
  id: z.string(),
  repository: repositoryRefSchema,
  pullRequestNumber: z.number().int().positive(),
  headSha: z.string().nullable(),
  status: reviewStatusSchema,
  skipReason: z.string().nullable(),
  findingCount: count,
  suppressedFindingCount: count,
  aiFindingCount: count.nullable(),
  startedAt: z.string(),
  durationMs: z.number(),
});

export const findingSchema = z.object({
  ruleId: z.string(),
  severity: z.string(),
  confidence: z.number().min(0).max(1),
  message: z.string(),
  filePath: z.string().nullable(),
  line: z.number().int().nullable(),
  suggestion: z.string().nullable(),
  evidence: z.array(z.object({ label: z.string(), value: z.string() })),
});

export const ruleExecutionSchema = z.object({
  ruleId: z.string(),
  ruleVersion: z.string(),
  status: z.string(),
  findingCount: count,
  durationMs: z.number(),
});

export const aiReviewSchema = z.object({
  provider: z.string(),
  model: z.string(),
  status: z.string(),
  failureReason: z.string().nullable(),
  findingCount: count,
  suppressedFindingCount: count,
  rejectedFindingCount: count,
  sentFileCount: count,
  omittedFileCount: count,
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  durationMs: z.number(),
});

export const reviewDetailsSchema = reviewSummarySchema.extend({
  baseSha: z.string().nullable(),
  commentAction: z.string().nullable(),
  skippedFileCount: count,
  omittedPatchCount: count,
  errorName: z.string().nullable(),
  errorStatus: z.number().nullable(),
  findings: z.array(findingSchema),
  rules: z.array(ruleExecutionSchema),
  aiReview: aiReviewSchema.nullable(),
});

export const meSchema = z.object({
  login: z.string(),
  installationCount: count,
  expiresAt: z.string(),
});

export const overviewSchema = z.object({
  since: z.string(),
  repositoryCount: count,
  reviewCount: count,
  completedCount: count,
  skippedCount: count,
  failedCount: count,
  findingCount: count,
  recentReviews: z.array(reviewSummarySchema),
});

export const repositoryListSchema = z.object({
  repositories: z.array(
    repositoryRefSchema.extend({
      reviewCount: count,
      lastReviewedAt: z.string().nullable(),
      lastStatus: reviewStatusSchema.nullable(),
    }),
  ),
});

export const reviewPageSchema = z.object({
  repository: repositoryRefSchema,
  reviews: z.array(reviewSummarySchema),
  nextCursor: z.string().nullable(),
});

export type ReviewStatus = z.infer<typeof reviewStatusSchema>;
export type RepositoryRef = z.infer<typeof repositoryRefSchema>;
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;
export type Finding = z.infer<typeof findingSchema>;
export type RuleExecution = z.infer<typeof ruleExecutionSchema>;
export type AiReview = z.infer<typeof aiReviewSchema>;
export type ReviewDetails = z.infer<typeof reviewDetailsSchema>;
export type Me = z.infer<typeof meSchema>;
export type Overview = z.infer<typeof overviewSchema>;
export type RepositoryList = z.infer<typeof repositoryListSchema>;
export type ReviewPage = z.infer<typeof reviewPageSchema>;
