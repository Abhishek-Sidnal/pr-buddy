import type { ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../api/client.js";
import { Loaded, StatusBadge, Timestamp } from "../components/common.js";
import { useResource } from "../use-resource.js";

export function RepositoriesPage(): ReactNode {
  const { resource } = useResource((signal) => api.repositories(signal), "repositories");
  return (
    <>
      <h1>Repositories</h1>
      <Loaded resource={resource}>
        {({ repositories }) =>
          repositories.length === 0 ? (
            <p className="muted">
              No repository you can access has been reviewed yet. A repository appears here after PR
              Buddy reviews its first pull request.
            </p>
          ) : (
            <table>
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
          )
        }
      </Loaded>
    </>
  );
}
