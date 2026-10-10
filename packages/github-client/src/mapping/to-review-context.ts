import {
  changedFileSchema,
  MAX_BODY_LENGTH,
  MAX_FILES,
  MAX_PATCH_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_TOTAL_PATCH_LENGTH,
  type FileStatus,
  type reviewContextSchema,
} from "@pr-buddy/review-engine";
import type { z } from "zod";
import type {
  FileListLimits,
  PullRequestFile,
  PullRequestSnapshot,
} from "../api/repository-client.js";

export type ReviewContextInput = z.input<typeof reviewContextSchema>;
type ChangedFileInput = z.input<typeof changedFileSchema>;

/** What may be fetched for one review: exactly what the review engine accepts. */
export const REVIEW_FILE_LIMITS: FileListLimits = {
  maxFiles: MAX_FILES,
  maxPatchLength: MAX_PATCH_LENGTH,
  maxTotalPatchLength: MAX_TOTAL_PATCH_LENGTH,
};

export interface MappedPullRequest {
  readonly context: ReviewContextInput;
  /** Files left out because the engine cannot represent them safely, such as unusual paths. */
  readonly skippedFileCount: number;
  /** Files that are reviewed without their patch because it exceeded a size limit. */
  readonly omittedPatchCount: number;
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

/** Converts one file, without its patch. Returns `undefined` if the engine would reject it. */
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
  };
  return changedFileSchema.safeParse(candidate).success ? candidate : undefined;
}

/**
 * Converts GitHub's description of a pull request into review engine input.
 *
 * Files the engine would reject are left out and counted, so one odd file cannot prevent the
 * whole review. A patch that is too long, or that would take the review past its total patch
 * budget, is dropped while its file is kept: rules still see that the file changed.
 */
export function toReviewContext(
  pullRequest: PullRequestSnapshot,
  files: readonly PullRequestFile[],
): MappedPullRequest {
  const changedFiles: ChangedFileInput[] = [];
  const seenPaths = new Set<string>();
  let skippedFileCount = 0;
  let omittedPatchCount = 0;
  let keptPatchLength = 0;

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

    const { patch } = file;
    const patchFits =
      patch !== undefined &&
      patch.length <= MAX_PATCH_LENGTH &&
      keptPatchLength + patch.length <= MAX_TOTAL_PATCH_LENGTH;
    if (patchFits) {
      keptPatchLength += patch.length;
      changedFiles.push({ ...changedFile, patch });
    } else {
      if (patch !== undefined || file.patchOmitted === true) {
        omittedPatchCount += 1;
      }
      changedFiles.push(changedFile);
    }
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
    omittedPatchCount,
  };
}
