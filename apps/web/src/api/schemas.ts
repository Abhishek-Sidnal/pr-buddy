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
  newerReviewId: z.string().nullable(),
});

/** Who runs this deployment, as its operator chose to say it. `null` means they did not say. */
export const operatorSchema = z.object({
  name: z.string().nullable(),
  /** An email address or an https:// address. It is checked again before it becomes a link. */
  contact: z.string().nullable(),
  privacyUrl: z.string().nullable(),
  termsUrl: z.string().nullable(),
});

export const UNNAMED_OPERATOR: z.infer<typeof operatorSchema> = {
  name: null,
  contact: null,
  privacyUrl: null,
  termsUrl: null,
};

/**
 * What a visitor may learn before signing in: the app to install, who runs the service, and
 * how many days reviews are kept (0 means for ever, `null` means the service did not say).
 */
export const serviceInfoSchema = z.object({
  appSlug: z.string().nullable(),
  operator: operatorSchema.default(UNNAMED_OPERATOR),
  retentionDays: z.number().int().min(0).nullable().default(null),
});

export const meSchema = z.object({
  login: z.string(),
  installationCount: count,
  expiresAt: z.string(),
  /** Whether this person runs the deployment. It only decides whether a link is shown. */
  isOperator: z.boolean().default(false),
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

export const reviewListingSchema = z.object({
  reviews: z.array(reviewSummarySchema),
  nextCursor: z.string().nullable(),
});

export const reviewPageSchema = reviewListingSchema.extend({ repository: repositoryRefSchema });

export type ReviewStatus = z.infer<typeof reviewStatusSchema>;
export type RepositoryRef = z.infer<typeof repositoryRefSchema>;
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;
export type Finding = z.infer<typeof findingSchema>;
export type RuleExecution = z.infer<typeof ruleExecutionSchema>;
export type AiReview = z.infer<typeof aiReviewSchema>;
export type ReviewDetails = z.infer<typeof reviewDetailsSchema>;
export type Me = z.infer<typeof meSchema>;
export type ServiceInfo = z.infer<typeof serviceInfoSchema>;
export type Overview = z.infer<typeof overviewSchema>;
export type RepositoryList = z.infer<typeof repositoryListSchema>;
export type ReviewListing = z.infer<typeof reviewListingSchema>;
export type ReviewPage = z.infer<typeof reviewPageSchema>;

export const CUSTOMER_PROVIDERS = ["anthropic", "openai", "bedrock", "azure"] as const;
export type CustomerProvider = (typeof CUSTOMER_PROVIDERS)[number];

/** What may be shown about a stored AI key. The key itself is never sent to the browser. */
export const aiKeySummarySchema = z.object({
  provider: z.string(),
  model: z.string(),
  region: z.string().nullable(),
  /** The Azure resource's name; `null` for every other provider. */
  resource: z.string().nullable(),
  keyHint: z.string(),
  updatedAt: z.string(),
});

export const installationListSchema = z.object({
  installations: z.array(
    z.object({
      id: z.number().int().positive(),
      account: z.string(),
      /** Whether the signed-in person may change this installation's AI key. */
      canManage: z.boolean(),
      aiKey: aiKeySummarySchema.nullable(),
    }),
  ),
});

/** The parts of a refusal that the settings page explains to the person. */
export const aiKeyErrorSchema = z.object({
  error: z.string(),
  providerStatus: z.number().optional(),
  fields: z.array(z.string()).optional(),
});

/** What the provider said when the stored key was tested. */
export const aiKeyTestSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("working") }),
  z.object({ result: z.literal("refused"), providerStatus: z.number().int() }),
  z.object({ result: z.literal("unreachable") }),
  z.object({ result: z.literal("unreadable") }),
  z.object({ result: z.literal("missing") }),
]);

const outcomeCountsSchema = z.object({ completed: count, skipped: count, failed: count });

/**
 * What the whole service has been doing, for its operator. Account names and counts only: the
 * API sends nothing about what was reviewed, and this schema would not keep it if it did.
 */
export const operatorOverviewSchema = z.object({
  generatedAt: z.string(),
  totals: z.object({ installations: count, repositories: count, people: count }),
  reviews: z.object({
    day: outcomeCountsSchema,
    week: outcomeCountsSchema,
    month: outcomeCountsSchema,
  }),
  aiReviews: outcomeCountsSchema,
  pending: z.object({ count, oldestRequestedAt: z.string().nullable() }),
  queue: z.object({ running: count, waiting: count }),
  keysByProvider: z.array(z.object({ provider: z.string(), count })),
  installations: z.array(
    z.object({
      installationId: z.number().int().positive(),
      account: z.string(),
      repositoryCount: count,
      reviewCount: count,
      failedCount: count,
      lastReviewAt: z.string().nullable(),
      aiProvider: z.string().nullable(),
    }),
  ),
});

export type OperatorOverview = z.infer<typeof operatorOverviewSchema>;
export type OutcomeCounts = z.infer<typeof outcomeCountsSchema>;

export type AiKeyTest = z.infer<typeof aiKeyTestSchema>;
export type AiKeySummary = z.infer<typeof aiKeySummarySchema>;
export type InstallationList = z.infer<typeof installationListSchema>;
export type Installation = InstallationList["installations"][number];
