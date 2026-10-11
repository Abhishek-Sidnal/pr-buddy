export { signWebhookBody, verifyWebhookSignature } from "./webhook/verify-signature.js";
export {
  parsePullRequestEvent,
  REVIEWABLE_ACTIONS,
  type ParsedPullRequestEvent,
  type ReviewableAction,
  type ReviewTrigger,
} from "./webhook/pull-request-event.js";
export { parseInstallationEvent, type InstallationChange } from "./webhook/installation-event.js";

export type {
  FileListLimits,
  FileLookup,
  NewLineComment,
  PullRequestFile,
  PullRequestSnapshot,
  RepositoryClient,
  RepositoryClientFactory,
  RepositoryTarget,
  ReviewComment,
} from "./api/repository-client.js";
export {
  createRepositoryClientFactory,
  type GitHubAppCredentials,
  type OctokitClientOptions,
} from "./api/octokit-client.js";
export {
  DEFAULT_RETRY,
  isRateLimitError,
  isTransientHttpError,
  withRetry,
  type RetryOptions,
} from "./api/retry.js";

export {
  REVIEW_FILE_LIMITS,
  toReviewContext,
  type MappedPullRequest,
  type ReviewContextInput,
} from "./mapping/to-review-context.js";

export {
  renderReviewSummary,
  SUMMARY_MARKER,
  type AiSummary,
  type SummaryNotes,
} from "./output/render-summary.js";
export {
  publishReviewSummary,
  type PublishAction,
  type PublishOptions,
} from "./output/publish-summary.js";
export { escapeMarkdown, inlineCode } from "./output/markdown.js";
export {
  fingerprintOf,
  MAX_INLINE_COMMENTS,
  planInlineComments,
  publishInlineComments,
  renderInlineComment,
  type InlineCommentPlan,
  type InlinePublishResult,
} from "./output/inline-comments.js";

export {
  createUserAuthClient,
  SignInError,
  type AccessibleInstallation,
  type GitHubUser,
  type OwnerCheckOutcome,
  type SignInFailure,
  type UserAccess,
  type UserAuthClient,
  type UserAuthClientOptions,
} from "./oauth/user-auth-client.js";
