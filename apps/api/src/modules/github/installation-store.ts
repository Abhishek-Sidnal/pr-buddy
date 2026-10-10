import type { InstallationChange } from "@pr-buddy/github-client";
import type { Database } from "../../database/database.js";
import { toBigintArrayLiteral } from "../auth/postgres-session-store.js";

/** What was removed in answer to a change of installation. */
export interface InstallationCleanup {
  readonly sessionsEnded: number;
  readonly repositoriesDeleted: number;
}

/**
 * Acts on GitHub's news that the app was uninstalled, suspended or lost repositories. See
 * docs/DESIGN-STORAGE.md, section 12.
 */
export interface InstallationStore {
  apply(change: Exclude<InstallationChange, { kind: "ignored" }>): Promise<InstallationCleanup>;
}

/** Used when no database is configured: there is nothing stored to clean up. */
export function createIdleInstallationStore(): InstallationStore {
  return { apply: () => Promise.resolve({ sessionsEnded: 0, repositoriesDeleted: 0 }) };
}

/**
 * An installation store backed by PostgreSQL. Each change is applied in one transaction, so a
 * reader never finds sessions that outlived the data they could see, or the reverse.
 */
export function createPostgresInstallationStore(database: Database): InstallationStore {
  return {
    apply(change) {
      const { installationId } = change;
      return database.transaction(async (transaction) => {
        // Everyone who could see this installation signs in again and gets a fresh list.
        const sessions = await transaction.query(
          "DELETE FROM sessions WHERE $1::bigint = ANY(installation_ids)",
          [installationId],
        );
        if (change.kind === "suspended") {
          return { sessionsEnded: sessions.rowCount, repositoriesDeleted: 0 };
        }

        // The installation is part of both conditions, so an event can never delete a
        // repository that has since moved to another installation.
        const repositoryFilter =
          change.kind === "removed" ? null : toBigintArrayLiteral(change.repositoryIds);
        await transaction.query(
          `DELETE FROM pending_reviews
           WHERE installation_id = $1
             AND ($2::bigint[] IS NULL OR repository_id = ANY($2::bigint[]))`,
          [installationId, repositoryFilter],
        );
        // Reviews, findings, rule executions and AI records go with their repository.
        const repositories = await transaction.query(
          `DELETE FROM repositories
           WHERE installation_id = $1
             AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))`,
          [installationId, repositoryFilter],
        );
        return { sessionsEnded: sessions.rowCount, repositoriesDeleted: repositories.rowCount };
      });
    },
  };
}
