import type { ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../api/client.js";
import { EmptyState, Loaded, PageHeader } from "../components/common.js";
import { ReviewTable } from "../components/review-table.js";
import { useResource } from "../use-resource.js";

function Metric(props: {
  readonly label: string;
  readonly value: number;
  readonly to?: string;
}): ReactNode {
  return (
    <div className="metric">
      <dt>{props.label}</dt>
      <dd>{props.to === undefined ? props.value : <Link to={props.to}>{props.value}</Link>}</dd>
    </div>
  );
}

/** What to do when nothing has been reviewed yet. */
export function NoReviewsYet(): ReactNode {
  return (
    <EmptyState title="No reviews yet">
      <p>
        PR Buddy reviews a pull request when it is opened or updated in a repository where the app
        is installed. Open or push to a pull request there, and its review appears here. Draft pull
        requests are reviewed once they are marked ready.
      </p>
    </EmptyState>
  );
}

export function OverviewPage(): ReactNode {
  const { resource, reload } = useResource((signal) => api.overview(signal), "overview");
  return (
    <>
      <PageHeader
        title="Overview"
        description="What PR Buddy reviewed in the repositories you can access."
      />
      <Loaded resource={resource} loadingLabel="Loading the overview…" onRetry={reload}>
        {(overview) => (
          <>
            <section aria-labelledby="totals-heading">
              <h2 id="totals-heading">Last 30 days</h2>
              <dl className="metrics">
                <Metric label="Reviews" value={overview.reviewCount} to="/history" />
                <Metric label="Findings" value={overview.findingCount} />
                <Metric
                  label="Skipped reviews"
                  value={overview.skippedCount}
                  to="/history?status=skipped"
                />
                <Metric
                  label="Failed reviews"
                  value={overview.failedCount}
                  to="/history?status=failed"
                />
              </dl>
            </section>
            <section aria-labelledby="recent-heading">
              <h2 id="recent-heading">Recent reviews</h2>
              {overview.recentReviews.length === 0 ? (
                <NoReviewsYet />
              ) : (
                <>
                  <ReviewTable
                    reviews={overview.recentReviews}
                    showRepository
                    caption="Recent reviews"
                  />
                  <p className="list-end">
                    <Link to="/history">See the full review history</Link>
                  </p>
                </>
              )}
            </section>
          </>
        )}
      </Loaded>
    </>
  );
}
