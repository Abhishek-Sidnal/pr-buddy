import { z } from "zod";
import { MAX_GLOB_EXPANSIONS, MAX_GLOB_LENGTH, MAX_GLOB_PATTERNS } from "../limits.js";

/*
 * A deliberately small glob dialect for repository paths:
 *
 *   *        any characters within one path segment
 *   ?        exactly one character within one path segment
 *   **       as a whole segment: zero or more path segments
 *   {a,b}    alternatives, which may be nested
 *
 * Every other character is literal, matching is case-sensitive, and there is no escaping.
 *
 * Patterns and paths can both be written by people the engine does not trust, so matching never
 * uses regular expressions or recursion: its cost is at most proportional to pattern length
 * times path length, whatever the input.
 */

const GLOBSTAR = "**";
const WHOLE_SEGMENT_OF_STARS = /^\*{2,}$/;

interface BraceGroup {
  readonly start: number;
  readonly end: number;
  readonly alternatives: readonly string[];
}

/** Finds the first top-level `{...}` group. Returns "none" or "unbalanced" if there is none. */
function findBraceGroup(pattern: string): BraceGroup | "none" | "unbalanced" {
  const start = pattern.indexOf("{");
  const firstClose = pattern.indexOf("}");
  if (start === -1) {
    return firstClose === -1 ? "none" : "unbalanced";
  }
  if (firstClose !== -1 && firstClose < start) {
    return "unbalanced";
  }

  const alternatives: string[] = [];
  let depth = 0;
  let alternativeStart = start + 1;
  for (let index = start; index < pattern.length; index += 1) {
    const character = pattern.charAt(index);
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        alternatives.push(pattern.slice(alternativeStart, index));
        return { start, end: index, alternatives };
      }
    } else if (character === "," && depth === 1) {
      alternatives.push(pattern.slice(alternativeStart, index));
      alternativeStart = index + 1;
    }
  }
  return "unbalanced";
}

/**
 * Expands brace alternatives: `a.{js,ts}` becomes `a.js` and `a.ts`. Returns `undefined` when
 * braces are unbalanced or the pattern expands to more than `MAX_GLOB_EXPANSIONS` patterns.
 */
export function expandBraces(pattern: string): string[] | undefined {
  const pending = [pattern];
  const expanded: string[] = [];

  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const group = findBraceGroup(current);
    if (group === "unbalanced") {
      return undefined;
    }
    if (group === "none") {
      expanded.push(current);
    } else {
      const before = current.slice(0, group.start);
      const after = current.slice(group.end + 1);
      // Reversed so that popping from the end yields the alternatives in the order written.
      for (const alternative of [...group.alternatives].reverse()) {
        pending.push(before + alternative + after);
      }
    }
    if (pending.length + expanded.length > MAX_GLOB_EXPANSIONS) {
      return undefined;
    }
  }
  return expanded;
}

/**
 * Matches a sequence against a pattern in which some elements are wildcards that stand for any
 * run of items. On a mismatch it resumes from the most recent wildcard instead of recursing, so
 * it makes at most `pattern.length * input.length` comparisons.
 */
function matchSequence(
  pattern: ArrayLike<string>,
  input: ArrayLike<string>,
  isWildcard: (element: string) => boolean,
  matchesItem: (element: string, item: string) => boolean,
): boolean {
  let patternIndex = 0;
  let inputIndex = 0;
  let resumePatternIndex = -1;
  let resumeInputIndex = 0;

  while (inputIndex < input.length) {
    const element = pattern[patternIndex];
    if (element !== undefined && isWildcard(element)) {
      patternIndex += 1;
      resumePatternIndex = patternIndex;
      resumeInputIndex = inputIndex;
    } else if (element !== undefined && matchesItem(element, input[inputIndex] as string)) {
      patternIndex += 1;
      inputIndex += 1;
    } else if (resumePatternIndex !== -1) {
      resumeInputIndex += 1;
      patternIndex = resumePatternIndex;
      inputIndex = resumeInputIndex;
    } else {
      return false;
    }
  }

  while (patternIndex < pattern.length && isWildcard(pattern[patternIndex] as string)) {
    patternIndex += 1;
  }
  return patternIndex === pattern.length;
}

const isStar = (character: string): boolean => character === "*";
const matchesCharacter = (expected: string, actual: string): boolean =>
  expected === "?" || expected === actual;

const isGlobstar = (segment: string): boolean => segment === GLOBSTAR;
const matchesSegment = (pattern: string, segment: string): boolean =>
  matchSequence(pattern, segment, isStar, matchesCharacter);

/** Splits a brace-free pattern into path segments, normalising `***` and longer to `**`. */
function toSegments(pattern: string): string[] {
  return pattern
    .split("/")
    .map((segment) => (WHOLE_SEGMENT_OF_STARS.test(segment) ? GLOBSTAR : segment));
}

export const globPatternSchema = z
  .string()
  .min(1)
  .max(MAX_GLOB_LENGTH)
  .refine(
    (pattern) => expandBraces(pattern) !== undefined,
    `must have balanced braces that expand to at most ${MAX_GLOB_EXPANSIONS} patterns`,
  );

export const globListSchema = z.array(globPatternSchema).max(MAX_GLOB_PATTERNS);

export type PathMatcher = (path: string) => boolean;

/**
 * Builds a predicate that is true when a repository path matches any of the glob patterns.
 * @throws {RangeError} if a pattern is invalid; validate untrusted patterns with
 * `globPatternSchema` first.
 */
export function createPathMatcher(patterns: readonly string[]): PathMatcher {
  const compiled = patterns.flatMap((pattern) => {
    const expanded = expandBraces(pattern);
    if (expanded === undefined) {
      throw new RangeError("Invalid glob pattern.");
    }
    return expanded.map(toSegments);
  });

  return (path) => {
    const segments = path.split("/");
    return compiled.some((pattern) => matchSequence(pattern, segments, isGlobstar, matchesSegment));
  };
}
