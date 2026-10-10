import {
  changedFileSchema,
  MAX_BODY_LENGTH,
  MAX_PATCH_LENGTH,
  MAX_TITLE_LENGTH,
  type FileStatus,
  type reviewContextSchema,
} from "@pr-buddy/review-engine";
import type { z } from "zod";
import type { PullRequestFile, PullRequestSnapshot } from "../api/repository-client.js";

export type ReviewContextInput = z.input<typeof reviewContextSchema>;
type ChangedFileInput = z.input<typeof changedFileSchema>;

export interface MappedPullRequest {
  readonly context: ReviewContextInput;
  /** Files left out because the engine cannot represent them safely, such as unusual paths. */
  readonly skippedFileCount: number;
}

/** GitHub statuses and the engine status each becomes. "unchanged" has no entry: it is dropped. */
const STATUS_BY_GITHUB_STATUS: ReadonlyMap<string, FileStatus> = new Map([
  ["added", "added"],
  ["removed", "removed"],
  ["modified", "modified"],
  ["changed", "modified"],
  ["renamed", "renamed"],
  ["copied", "copied"],
]);

const UNCHANGED = "unchanged";

function toChangedFile(file: PullRequestFile): ChangedFileInput | undefined {
  const mappedStatus = STATUS_BY_GITHUB_STATUS.get(file.status);
  if (mappedStatus === undefined) {
    return undefined;
  }
  const hasOrigin = mappedStatus === "renamed" || mappedStatus === "copied";
  // The engine requires a previous path for a rename or copy; without one it is an edit.
  const status = hasOrigin && file.previousPath === undefined ? "modified" : mappedStatus;

  const candidate: ChangedFileInput = {
    path: file.path,
    status,
    additions: file.additions,
    deletions: file.deletions,
    ...(hasOrigin && file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
    // An oversized patch is dropped rather than the file: rules still see that it changed.
    ...(file.patch !== undefined && file.patch.length <= MAX_PATCH_LENGTH
      ? { patch: file.patch }
      : {}),
  };
  return changedFileSchema.safeParse(candidate).success ? candidate : undefined;
}

/**
 * Converts GitHub's description of a pull request into review engine input. Files the engine
 * would reject are left out and counted, so one odd file cannot prevent the whole review.
 */
export function toReviewContext(
  pullRequest: PullRequestSnapshot,
  files: readonly PullRequestFile[],
): MappedPullRequest {
  const changedFiles: ChangedFileInput[] = [];
  const seenPaths = new Set<string>();
  let skippedFileCount = 0;

  for (const file of files) {
    if (file.status === UNCHANGED) {
      continue;
    }
    const changedFile = toChangedFile(file);
    if (changedFile === undefined || seenPaths.has(changedFile.path)) {
      skippedFileCount += 1;
      continue;
    }
    seenPaths.add(changedFile.path);
    changedFiles.push(changedFile);
  }

  return {
    context: {
      pullRequest: {
        number: pullRequest.number,
        title: pullRequest.title.slice(0, MAX_TITLE_LENGTH),
        body: pullRequest.body === null ? null : pullRequest.body.slice(0, MAX_BODY_LENGTH),
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
      },
      files: changedFiles,
    },
    skippedFileCount,
  };
}
