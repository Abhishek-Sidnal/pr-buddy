import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client.js";
import type { ReviewListing, ReviewSummary } from "../api/schemas.js";
import { shortCommit } from "../format.js";
import { commitUrl, pullRequestUrl } from "../github-links.js";
import { ErrorState, ExternalLink, StatusBadge, Timestamp } from "./common.js";

const SKIP_REASONS: Readonly<Record<string, string>> = {
  draft: "Draft",
  closed: "Closed",
  stale: "Superseded by a newer commit",
};

function describeFindings(review: ReviewSummary): string {
  if (review.status === "skipped") {
    return SKIP_REASONS[review.skipReason ?? ""] ?? review.skipReason ?? "—";
  }
  if (review.status === "failed") {
    return "—";
  }
  const ai = review.aiFindingCount === null ? "" : ` + ${review.aiFindingCount} AI`;
  return `${review.findingCount}${ai}`;
}

/** A list of reviews. The repository column is left out on a page about one repository. */
export function ReviewTable(props: {
  readonly reviews: readonly ReviewSummary[];
  readonly showRepository: boolean;
  readonly caption: string;
}): ReactNode {
  return (
    <div className="table-wrap">
      <table>
        <caption className="visually-hidden">{props.caption}</caption>
        <thead>
          <tr>
            <th scope="col">Reviewed</th>
            {props.showRepository ? <th scope="col">Repository</th> : null}
            <th scope="col">Pull request</th>
            <th scope="col">Commit</th>
            <th scope="col">Outcome</th>
            <th scope="col">Findings</th>
          </tr>
        </thead>
        <tbody>
          {props.reviews.map((review) => (
            <tr key={review.id}>
              <td>
                <Link to={`/reviews/${review.id}`}>
                  <Timestamp iso={review.startedAt} />
                </Link>
              </td>
              {props.showRepository ? (
                <td>
                  <Link to={`/repositories/${review.repository.id}`}>
                    {review.repository.owner}/{review.repository.name}
                  </Link>
                </td>
              ) : null}
              <td>
                <ExternalLink href={pullRequestUrl(review.repository, review.pullRequestNumber)}>
                  #{review.pullRequestNumber}
                </ExternalLink>
              </td>
              <td>
                {review.headSha === null ? (
                  "—"
                ) : (
                  <ExternalLink href={commitUrl(review.repository, review.headSha)}>
                    <code>{shortCommit(review.headSha)}</code>
                  </ExternalLink>
                )}
              </td>
              <td>
                <StatusBadge status={review.status} />
              </td>
              <td>{describeFindings(review)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A review table that grows: older pages are added below the first as they are asked for. Give
 * it a `key` that changes with the list it shows, so a new list starts afresh.
 */
export function ReviewList(props: {
  readonly firstPage: ReviewListing;
  readonly loadOlder: (cursor: string) => Promise<ReviewListing>;
  readonly showRepository: boolean;
  readonly caption: string;
  /** Shown instead of the table when there is nothing to list. */
  readonly empty: ReactNode;
}): ReactNode {
  const [older, setOlder] = useState<readonly ReviewSummary[]>([]);
  const [cursor, setCursor] = useState(props.firstPage.nextCursor);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ApiError>();

  async function loadMore(from: string): Promise<void> {
    setIsLoading(true);
    setError(undefined);
    try {
      const page = await props.loadOlder(from);
      setOlder((current) => [...current, ...page.reviews]);
      setCursor(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError("failed"));
    } finally {
      setIsLoading(false);
    }
  }

  const reviews = [...props.firstPage.reviews, ...older];
  if (reviews.length === 0) {
    return props.empty;
  }
  return (
    <>
      <ReviewTable
        reviews={reviews}
        showRepository={props.showRepository}
        caption={props.caption}
      />
      {error === undefined ? null : <ErrorState error={error} />}
      {cursor === null ? (
        <p className="list-end">
          {reviews.length === 1 ? "1 review" : `${reviews.length} reviews`}, all shown.
        </p>
      ) : (
        <button
          type="button"
          className="button button-secondary"
          disabled={isLoading}
          onClick={() => void loadMore(cursor)}
        >
          {isLoading ? "Loading older reviews…" : "Show older reviews"}
        </button>
      )}
    </>
  );
}
