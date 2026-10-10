/** Glob patterns that several rules use as defaults. */

const SCRIPT_EXTENSIONS = "{js,jsx,mjs,cjs,ts,tsx,mts,cts}";

/** JavaScript and TypeScript files. */
export const SCRIPT_FILE_PATTERNS: readonly string[] = [`**/*.${SCRIPT_EXTENSIONS}`];

/** Where JavaScript and TypeScript projects usually keep tests. */
export const TEST_FILE_PATTERNS: readonly string[] = [
  `**/*.{test,spec}.${SCRIPT_EXTENSIONS}`,
  "**/__tests__/**",
  "**/{test,tests,e2e}/**",
];

/** Source-like files that are not normally covered by their own tests. */
export const UNTESTED_SOURCE_PATTERNS: readonly string[] = [
  "**/*.d.{ts,mts,cts}",
  `**/*.config.${SCRIPT_EXTENSIONS}`,
  `**/*.stories.${SCRIPT_EXTENSIONS}`,
];

/** Generated lockfiles say nothing about how hard a pull request is to review. */
export const LOCKFILE_PATTERNS: readonly string[] = [
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
];
