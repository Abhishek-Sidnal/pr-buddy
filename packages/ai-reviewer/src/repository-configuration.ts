import { ConfigurationError, createReviewEngine, type ReviewEngine } from "@pr-buddy/review-engine";
import { z } from "zod";
import { MAX_SETTINGS_ISSUE_LENGTH } from "./limits.js";
import { parseAiSettings } from "./settings.js";

/** Where a repository keeps its PR Buddy settings. */
export const CONFIGURATION_PATH = ".github/pr-buddy.json";
/** A larger file is not read. */
export const MAX_CONFIGURATION_BYTES = 64 * 1_024;

/**
 * Who reviews a repository: the hosted service, from the diff, or a GitHub Action in the
 * repository's own CI. Never both (D-105).
 */
export const REVIEW_MODES = ["hosted", "runner"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/** The `review` section of a repository's configuration. */
export const reviewSettingsSchema = z.strictObject({
  mode: z.enum(REVIEW_MODES).default("hosted"),
});

/** A repository's configuration file, as it was found at a commit. */
export type ConfigurationLookup =
  | { readonly status: "found"; readonly text: string }
  | { readonly status: "missing" }
  | { readonly status: "too-large" };

/** What a repository's configuration means for a review. */
export interface RepositoryConfiguration {
  readonly engine: ReviewEngine;
  /** Whether the repository allows its pull requests to be sent to an AI provider. */
  readonly isAiEnabled: boolean;
  readonly mode: ReviewMode;
  /** Why the file was not used; empty when it was used, or when there is none. */
  readonly issues: readonly string[];
}

/**
 * Splits off the sections the review engine does not know. The engine would reject them as
 * unknown fields.
 */
function splitConfiguration(config: unknown): {
  ai: unknown;
  review: unknown;
  engineConfig: unknown;
} {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return { ai: undefined, review: undefined, engineConfig: config };
  }
  const { ai, review, ...engineConfig } = config as Record<string, unknown>;
  return { ai, review, engineConfig };
}

/**
 * Reads a repository's configuration as a whole. The hosted service and the Action both call
 * this, on the file at the pull request's base commit, so they cannot disagree about who
 * reviews.
 *
 * A file that is wrong in any part is not used at all: the defaults apply, which means no AI
 * review and **hosted** mode. A broken file can therefore never send code anywhere, never turn
 * runner mode on, and never leave a pull request with two reviewers.
 */
export function parseRepositoryConfiguration(
  lookup: ConfigurationLookup,
  defaultEngine: ReviewEngine = createReviewEngine(),
): RepositoryConfiguration {
  const useDefaults = (...issues: string[]): RepositoryConfiguration => ({
    engine: defaultEngine,
    isAiEnabled: false,
    mode: "hosted",
    issues,
  });

  if (lookup.status === "missing") {
    return useDefaults();
  }
  if (lookup.status === "too-large") {
    return useDefaults("The file is larger than 64 KB.");
  }

  let config: unknown;
  try {
    config = JSON.parse(lookup.text);
  } catch {
    return useDefaults("The file is not valid JSON.");
  }

  const { ai, review, engineConfig } = splitConfiguration(config);
  const aiSettings = parseAiSettings(ai);
  const reviewSettings = reviewSettingsSchema.safeParse(review ?? {});
  const sectionIssues = [
    ...(aiSettings.ok ? [] : aiSettings.issues),
    ...(reviewSettings.success
      ? []
      : reviewSettings.error.issues.map((issue) =>
          `${["review", ...issue.path.map(String)].join(".")}: ${issue.message}`.slice(
            0,
            MAX_SETTINGS_ISSUE_LENGTH,
          ),
        )),
  ];

  let engine: ReviewEngine;
  try {
    engine = createReviewEngine({ config: engineConfig });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return useDefaults(...error.issues, ...sectionIssues);
    }
    throw error;
  }
  if (!aiSettings.ok || !reviewSettings.success) {
    return useDefaults(...sectionIssues);
  }
  return {
    engine,
    isAiEnabled: aiSettings.settings.enabled,
    mode: reviewSettings.data.mode,
    issues: [],
  };
}
