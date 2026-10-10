import type { RepositoryRef } from "./api/schemas.js";

/**
 * Links to GitHub are built from stored values. Each value is checked against what GitHub itself
 * allows before it becomes part of a URL; anything else yields no link at all, so a stored value
 * can never choose the scheme, the host or an extra path.
 */

const GITHUB = "https://github.com";
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const COMMIT_ID = /^[0-9a-f]{40}$/;

export function repositoryUrl(repository: RepositoryRef): string | undefined {
  const { owner, name } = repository;
  // "." and ".." are valid for the pattern and are path segments with a meaning of their own.
  if (!OWNER.test(owner) || !REPOSITORY_NAME.test(name) || name === "." || name === "..") {
    return undefined;
  }
  return `${GITHUB}/${owner}/${name}`;
}

export function pullRequestUrl(repository: RepositoryRef, number: number): string | undefined {
  const base = repositoryUrl(repository);
  return base !== undefined && Number.isSafeInteger(number) && number > 0
    ? `${base}/pull/${number}`
    : undefined;
}

export function commitUrl(repository: RepositoryRef, commitId: string | null): string | undefined {
  const base = repositoryUrl(repository);
  return base !== undefined && commitId !== null && COMMIT_ID.test(commitId)
    ? `${base}/commit/${commitId}`
    : undefined;
}

const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

/** Where a person installs the operator's GitHub App, or nothing if its name is not one. */
export function appInstallUrl(appSlug: string | null | undefined): string | undefined {
  return typeof appSlug === "string" && APP_SLUG.test(appSlug)
    ? `${GITHUB}/apps/${appSlug}/installations/new`
    : undefined;
}
