import type { ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../api/client.js";
import { EmptyState, Loaded, PageHeader, StatusBadge, Timestamp } from "../components/common.js";
import { useResource } from "../use-resource.js";

export function RepositoriesPage(): ReactNode {
  const { resource, reload } = useResource((signal) => api.repositories(signal), "repositories");
  return (
    <>
      <PageHeader
        title="Repositories"
        description="Repositories PR Buddy has reviewed, among those GitHub says you can access."
      />
      <Loaded resource={resource} loadingLabel="Loading repositories…" onRetry={reload}>
        {({ repositories }) =>
          repositories.length === 0 ? (
            <EmptyState title="No reviewed repositories yet">
              <p>
                A repository appears here after PR Buddy reviews its first pull request. Which
                repositories the app can see is chosen on GitHub, in the app&apos;s installation
                settings; how a repository is reviewed is set in its{" "}
                <code>.github/pr-buddy.json</code> file.
              </p>
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <caption className="visually-hidden">Reviewed repositories</caption>
                <thead>
                  <tr>
                    <th scope="col">Repository</th>
                    <th scope="col">Reviews</th>
                    <th scope="col">Last reviewed</th>
                    <th scope="col">Last outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {repositories.map((repository) => (
                    <tr key={repository.id}>
                      <td>
                        <Link to={`/repositories/${repository.id}`}>
                          {repository.owner}/{repository.name}
                        </Link>
                      </td>
                      <td>{repository.reviewCount}</td>
                      <td>
                        {repository.lastReviewedAt === null ? (
                          "—"
                        ) : (
                          <Timestamp iso={repository.lastReviewedAt} />
                        )}
                      </td>
                      <td>
                        {repository.lastStatus === null ? (
                          "—"
                        ) : (
                          <StatusBadge status={repository.lastStatus} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loaded>
    </>
  );
}
