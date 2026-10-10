import type { ReactNode } from "react";
import { api } from "../api/client.js";
import { Loaded } from "../components/common.js";
import { ReviewTable } from "../components/review-table.js";
import { useResource } from "../use-resource.js";

function Stat(props: { readonly label: string; readonly value: number }): ReactNode {
  return (
    <div className="stat">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

export function OverviewPage(): ReactNode {
  const { resource } = useResource((signal) => api.overview(signal), "overview");
  return (
    <>
      <h1>Overview</h1>
      <Loaded resource={resource}>
        {(overview) => (
          <>
            <h2>Last 30 days</h2>
            <dl className="stats">
              <Stat label="Repositories" value={overview.repositoryCount} />
              <Stat label="Reviews" value={overview.reviewCount} />
              <Stat label="Findings" value={overview.findingCount} />
              <Stat label="Skipped reviews" value={overview.skippedCount} />
              <Stat label="Failed reviews" value={overview.failedCount} />
            </dl>
            <h2>Recent reviews</h2>
            <ReviewTable reviews={overview.recentReviews} showRepository />
          </>
        )}
      </Loaded>
    </>
  );
}
