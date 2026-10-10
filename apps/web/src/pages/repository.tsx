import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api/client.js";
import { ExternalLink, Loaded, PageHeader } from "../components/common.js";
import { Icon } from "../components/icon.js";
import { ReviewList } from "../components/review-table.js";
import { repositoryUrl } from "../github-links.js";
import { useResource } from "../use-resource.js";
import { NoReviewsYet } from "./overview.js";

export function RepositoryPage(): ReactNode {
  const repositoryId = useParams()["repositoryId"] ?? "";
  const { resource, reload } = useResource(
    (signal) => api.reviews(repositoryId, undefined, signal),
    `repository:${repositoryId}`,
  );
  return (
    <>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/repositories">Repositories</Link>
      </nav>
      <Loaded resource={resource} loadingLabel="Loading reviews…" onRetry={reload}>
        {(page) => {
          const url = repositoryUrl(page.repository);
          return (
            <>
              <PageHeader
                title={`${page.repository.owner}/${page.repository.name}`}
                description="Every review of this repository's pull requests, newest first."
                {...(url === undefined
                  ? {}
                  : {
                      action: (
                        <ExternalLink className="button button-secondary" href={url}>
                          Open on GitHub <Icon name="external" />
                        </ExternalLink>
                      ),
                    })}
              />
              <ReviewList
                key={repositoryId}
                firstPage={page}
                loadOlder={(cursor) => api.reviews(repositoryId, cursor)}
                showRepository={false}
                caption={`Reviews of ${page.repository.owner}/${page.repository.name}`}
                empty={<NoReviewsYet />}
              />
            </>
          );
        }}
      </Loaded>
    </>
  );
}
