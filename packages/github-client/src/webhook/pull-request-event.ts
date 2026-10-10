import { z } from "zod";

/** `pull_request` actions after which the review may have changed. */
export const REVIEWABLE_ACTIONS = [
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "edited",
] as const;

export type ReviewableAction = (typeof REVIEWABLE_ACTIONS)[number];

const positiveIdSchema = z.number().int().positive();
/** Owner and repository names as GitHub allows them; anything else never reaches a URL. */
const nameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);

/** Only the fields PR Buddy acts on. GitHub's payload has many more, which are ignored. */
const pullRequestEventSchema = z.object({
  action: z.string().max(100),
  number: positiveIdSchema,
  installation: z.object({ id: positiveIdSchema }),
  repository: z.object({
    id: positiveIdSchema,
    name: nameSchema,
    owner: z.object({ login: nameSchema }),
  }),
});

/**
 * What a webhook asks for: "review this pull request". It deliberately carries no title,
 * description or commit; those are fetched from the API when the review runs.
 */
export interface ReviewTrigger {
  readonly action: ReviewableAction;
  readonly installationId: number;
  readonly repository: {
    readonly id: number;
    readonly owner: string;
    readonly name: string;
  };
  readonly pullRequestNumber: number;
}

export type ParsedPullRequestEvent =
  | { readonly kind: "review"; readonly trigger: ReviewTrigger }
  | { readonly kind: "ignored"; readonly reason: "malformed-payload" | "unsupported-action" };

function isReviewableAction(action: string): action is ReviewableAction {
  return (REVIEWABLE_ACTIONS as readonly string[]).includes(action);
}

/** Interprets the JSON body of a `pull_request` webhook. Never throws. */
export function parsePullRequestEvent(payload: unknown): ParsedPullRequestEvent {
  const parsed = pullRequestEventSchema.safeParse(payload);
  if (!parsed.success) {
    return { kind: "ignored", reason: "malformed-payload" };
  }
  const { action, number, installation, repository } = parsed.data;
  if (!isReviewableAction(action)) {
    return { kind: "ignored", reason: "unsupported-action" };
  }
  return {
    kind: "review",
    trigger: {
      action,
      installationId: installation.id,
      repository: { id: repository.id, owner: repository.owner.login, name: repository.name },
      pullRequestNumber: number,
    },
  };
}
