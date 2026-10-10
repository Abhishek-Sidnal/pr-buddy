import type { ChangedFile } from "../context/context.schema.js";
import { getNewSideLines } from "../diff/parse-patch.js";
import type { ReviewFinding } from "./finding.schema.js";

export interface LocationCheck {
  /** The finding, with any unverifiable location removed. */
  readonly finding: ReviewFinding;
  /** Why part of the location was removed; absent when nothing was removed. */
  readonly removalReason?: string;
}

export type LocationValidator = (finding: ReviewFinding) => LocationCheck;

/**
 * Builds a validator that checks a finding's file and line against the diff. A file must be one
 * of the changed files; a line must be an added or context line in that file's patch. Whatever
 * cannot be verified is removed, so the engine never reports an invented location.
 */
export function createLocationValidator(files: readonly ChangedFile[]): LocationValidator {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const linesByPath = new Map<string, ReadonlySet<number>>();

  function describeUnverifiableLine(file: ChangedFile, line: number): string | undefined {
    if (file.status === "removed") {
      return `"${file.path}" was removed, so it has no lines to point at`;
    }
    if (file.patch === undefined) {
      return `"${file.path}" has no patch, so line ${line} cannot be verified`;
    }
    let lines = linesByPath.get(file.path);
    if (lines === undefined) {
      lines = getNewSideLines(file.patch);
      linesByPath.set(file.path, lines);
    }
    return lines.has(line) ? undefined : `line ${line} of "${file.path}" is not part of the diff`;
  }

  return (finding) => {
    const { filePath, line, ...withoutLocation } = finding;

    if (filePath === undefined) {
      return line === undefined
        ? { finding }
        : { finding: withoutLocation, removalReason: "a line was given without a file" };
    }

    const file = filesByPath.get(filePath);
    if (file === undefined) {
      return {
        finding: withoutLocation,
        removalReason: `"${filePath}" is not one of the changed files`,
      };
    }
    if (line === undefined) {
      return { finding };
    }

    const removalReason = describeUnverifiableLine(file, line);
    return removalReason === undefined
      ? { finding }
      : { finding: { ...withoutLocation, filePath }, removalReason };
  };
}
