import { useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { api, ApiError } from "../api/client.js";
import type { ReviewPage, ReviewSummary } from "../api/schemas.js";
import { ErrorMessage, ExternalLink, Loaded } from "../components/common.js";
import { ReviewTable } from "../components/review-table.js";
import { repositoryUrl } from "../github-links.js";
import { useResource } from "../use-resource.js";

/** The reviews of one repository. Later pages are added below the first as they are asked for. */
function ReviewList(props: {
  readonly repositoryId: string;
  readonly firstPage: ReviewPage;
}): ReactNode {
  const [older, setOlder] = useState<readonly ReviewSummary[]>([]);
  const [cursor, setCursor] = useState(props.firstPage.nextCursor);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ApiError>();

  async function loadMore(from: string): Promise<void> {
    setIsLoading(true);
    setError(undefined);
    try {
      const page = await api.reviews(props.repositoryId, from);
      setOlder((current) => [...current, ...page.reviews]);
      setCursor(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError("failed"));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <ReviewTable reviews={[...props.firstPage.reviews, ...older]} showRepository={false} />
      {error === undefined ? null : <ErrorMessage error={error} />}
      {cursor === null ? null : (
        <button type="button" disabled={isLoading} onClick={() => void loadMore(cursor)}>
          {isLoading ? "Loading…" : "Show older reviews"}
        </button>
      )}
    </>
  );
}

export function RepositoryPage(): ReactNode {
  const repositoryId = useParams()["repositoryId"] ?? "";
  const { resource } = useResource(
    (signal) => api.reviews(repositoryId, undefined, signal),
    `repository:${repositoryId}`,
  );
  return (
    <Loaded resource={resource}>
      {(page) => (
        <>
          <h1>
            {page.repository.owner}/{page.repository.name}
          </h1>
          <p>
            <ExternalLink href={repositoryUrl(page.repository)}>Open on GitHub</ExternalLink>
          </p>
          <h2>Reviews</h2>
          {/* A new key starts the list afresh when another repository is opened. */}
          <ReviewList key={repositoryId} repositoryId={repositoryId} firstPage={page} />
        </>
      )}
    </Loaded>
  );
}
