import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api/client.js";
import { reviewStatusSchema, type ReviewStatus } from "../api/schemas.js";
import { EmptyState, Loaded, PageHeader } from "../components/common.js";
import { ReviewList } from "../components/review-table.js";
import { useResource } from "../use-resource.js";
import { NoReviewsYet } from "./overview.js";

const FILTERS: readonly { readonly status: ReviewStatus | undefined; readonly label: string }[] = [
  { status: undefined, label: "All" },
  { status: "completed", label: "Completed" },
  { status: "skipped", label: "Skipped" },
  { status: "failed", label: "Failed" },
];

/** The outcome filter lives in the address, so a filtered list can be bookmarked and shared. */
function useStatusFilter(): ReviewStatus | undefined {
  const [search] = useSearchParams();
  const parsed = reviewStatusSchema.safeParse(search.get("status"));
  return parsed.success ? parsed.data : undefined;
}

export function HistoryPage(): ReactNode {
  const status = useStatusFilter();
  const { resource, reload } = useResource(
    (signal) => api.allReviews({ status }, signal),
    `history:${status ?? "all"}`,
  );
  return (
    <>
      <PageHeader
        title="Review history"
        description="Every review PR Buddy recorded, newest first. Each row names the commit that was reviewed."
      />
      <nav aria-label="Filter by outcome" className="filters">
        {FILTERS.map((filter) => (
          <Link
            key={filter.label}
            to={filter.status === undefined ? "/history" : `/history?status=${filter.status}`}
            aria-current={filter.status === status ? "true" : undefined}
          >
            {filter.label}
          </Link>
        ))}
      </nav>
      <Loaded resource={resource} loadingLabel="Loading reviews…" onRetry={reload}>
        {(page) => (
          <ReviewList
            key={status ?? "all"}
            firstPage={page}
            loadOlder={(cursor) => api.allReviews({ status, cursor })}
            showRepository
            caption={status === undefined ? "All reviews" : `Reviews that were ${status}`}
            empty={
              status === undefined ? (
                <NoReviewsYet />
              ) : (
                <EmptyState title={`No ${status} reviews`}>
                  <p>
                    Nothing matches this filter. <Link to="/history">Show all reviews</Link>
                  </p>
                </EmptyState>
              )
            }
          />
        )}
      </Loaded>
      <p className="footnote">
        Reviews are kept until they are deleted from the database; there is no automatic retention
        limit yet.
      </p>
    </>
  );
}
