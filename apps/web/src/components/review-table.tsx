import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ReviewSummary } from "../api/schemas.js";
import { shortCommit } from "../format.js";
import { commitUrl, pullRequestUrl } from "../github-links.js";
import { ExternalLink, StatusBadge, Timestamp } from "./common.js";

function describeFindings(review: ReviewSummary): string {
  if (review.status !== "completed") {
    return review.skipReason ?? "—";
  }
  const ai = review.aiFindingCount === null ? "" : ` + ${review.aiFindingCount} AI`;
  return `${review.findingCount}${ai}`;
}

/** A list of reviews. The repository column is left out on a page about one repository. */
export function ReviewTable(props: {
  readonly reviews: readonly ReviewSummary[];
  readonly showRepository: boolean;
}): ReactNode {
  if (props.reviews.length === 0) {
    return <p className="muted">No reviews yet.</p>;
  }
  return (
    <table>
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
  );
}
