import type { RepositoryClient } from "../api/repository-client.js";
import { SUMMARY_MARKER } from "./render-summary.js";

export type PublishAction = "created" | "updated" | "none";

export interface PublishOptions {
  /**
   * Whether to post a new comment when PR Buddy has not commented yet. False for a review with
   * nothing to say: an existing comment is still corrected, but a clean pull request stays quiet.
   */
  readonly createIfMissing: boolean;
}

/**
 * Publishes a summary as PR Buddy's single comment on a pull request, updating that comment in
 * place if it exists. Calling it again with the same body changes nothing visible.
 */
export async function publishReviewSummary(
  client: RepositoryClient,
  pullRequestNumber: number,
  body: string,
  options: PublishOptions,
): Promise<PublishAction> {
  const existingCommentId = await client.findOwnComment(pullRequestNumber, SUMMARY_MARKER);
  if (existingCommentId !== undefined) {
    await client.updateComment(existingCommentId, body);
    return "updated";
  }
  if (!options.createIfMissing) {
    return "none";
  }
  await client.createComment(pullRequestNumber, body);
  return "created";
}
