# PR Buddy — Tracker

Status of the work. Update this file in the same change that moves a task.

Legend: ✅ done · 🚧 in progress · ⬜ not started

## Milestones

| Milestone | Deliverable                  | Status |
| --------- | ---------------------------- | ------ |
| M1        | Deterministic review engine  | ✅     |
| M2        | GitHub App integration       | ⬜     |
| M3        | AI review, policy, dashboard | ⬜     |
| M4        | Hardening and `v0.1.0`       | ⬜     |

## Milestone 1 — review engine

### Documentation

| Task                                                                  | Status |
| --------------------------------------------------------------------- | ------ |
| PRD, architecture, design, security, brain, context, tracker          | ✅     |
| Rule reference                                                        | ✅     |
| README, contributing guide, security policy, code of conduct, license | ✅     |

### Project setup

| Task                                                        | Status |
| ----------------------------------------------------------- | ------ |
| npm workspaces, strict TypeScript, ESLint, Prettier, Vitest | ✅     |
| Docker development environment                              | ✅     |
| CI workflow, Dependabot, issue and PR templates             | ✅     |

The CI workflow has been written but has not run: the repository is not on GitHub yet.

### Engine

| Task                                 | Requirement  | Status |
| ------------------------------------ | ------------ | ------ |
| Limits and error classes             | NFR-7        | ✅     |
| Review context schema and safe paths | FR-1, FR-10  | ✅     |
| Finding schema and severity          | FR-1, FR-7   | ✅     |
| Patch parser                         | FR-11        | ✅     |
| Finding location validation          | FR-11        | ✅     |
| Rule contract and registry           | FR-2, FR-6   | ✅     |
| Configuration schema and resolution  | FR-8, FR-9   | ✅     |
| Engine pipeline with rule isolation  | FR-12, NFR-6 | ✅     |
| Glob matcher with bounded cost       | NFR-7        | ✅     |
| Rule `pr-description`                | FR-3         | ✅     |
| Rule `max-changed-files`             | FR-4         | ✅     |
| Rule `missing-test-changes`          | FR-5         | ✅     |

### Tests

| Task                                                   | Status |
| ------------------------------------------------------ | ------ |
| Unit tests for every module                            | ✅     |
| Positive, negative and edge-case tests for every rule  | ✅     |
| Malformed-input tests for context and configuration    | ✅     |
| Fixtures: added, removed, renamed, mixed, empty        | ✅     |
| Integration tests, including the example configuration | ✅     |

### Acceptance

Last run on 2026-10-10 with `docker compose run --rm dev npm run check` (Node.js 24).

| Check      | Result                                            |
| ---------- | ------------------------------------------------- |
| Formatting | Passed                                            |
| Lint       | Passed                                            |
| Type-check | Passed                                            |
| Tests      | Passed: 348 tests in 11 files                     |
| Coverage   | 100% of statements, branches, functions and lines |
| Build      | Passed                                            |
| Audit      | `npm audit`: no known vulnerabilities             |

### Open items before publishing

| Item                                                              | Owner      |
| ----------------------------------------------------------------- | ---------- |
| Make the first commit and push to GitHub, then confirm CI passes  | Maintainer |
| Enable private vulnerability reporting in the repository settings | Maintainer |
| Add a contact method for code of conduct reports to the profile   | Maintainer |
| Decide the copyright holder named in `LICENSE`                    | Maintainer |

## Backlog

| Item                                                                    | Milestone |
| ----------------------------------------------------------------------- | --------- |
| `packages/github-client`: map GitHub API data to `ReviewContext`        | M2        |
| Webhook receiver with signature verification and delivery deduplication | M2        |
| Database schema and migrations                                          | M2        |
| Publish summary and inline comments; stale-review protection            | M2        |
| Safe loading of a repository configuration file from the base branch    | M2        |
| Rules: debug code, risky configuration changes, change size by lines    | M2        |
| AI reviewer behind a provider interface                                 | M3        |
| Severity and confidence thresholds                                      | M3        |
| Dashboard: overview, repositories, review details, settings             | M3        |
| Run third-party rules in a worker thread with a hard time limit         | M3        |
| Pin GitHub Actions to commit SHAs                                       | M4        |
| Release `v0.1.0`                                                        | M4        |

## Change log

| Date       | Change                                                                               |
| ---------- | ------------------------------------------------------------------------------------ |
| 2026-10-10 | Project documentation written; Milestone 1 started                                   |
| 2026-10-10 | Review engine, three rules, tests and tooling implemented                            |
| 2026-10-10 | Replaced picomatch with an own glob matcher after measuring a denial-of-service risk |
| 2026-10-10 | Milestone 1 acceptance checks passed                                                 |
