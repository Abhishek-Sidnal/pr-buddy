# PR Buddy — Tracker

Status of the work. Update this file in the same change that moves a task.

Legend: ✅ done · 🚧 in progress · ⬜ not started

## Milestones

| Milestone | Deliverable                  | Status |
| --------- | ---------------------------- | ------ |
| M1        | Deterministic review engine  | ✅     |
| M2        | GitHub App integration       | ✅     |
| M3        | AI review, policy, dashboard | ⬜     |
| M4        | Hardening and `v0.1.0`       | ⬜     |

## Milestone 2 — GitHub App

### Documentation

| Task                                                              | Status |
| ----------------------------------------------------------------- | ------ |
| Requirements in the PRD, GitHub App design, setup guide           | ✅     |
| Security: threats and controls for the webhook, API and container | ✅     |
| Decisions D-017 to D-022                                          | ✅     |

### GitHub client (`packages/github-client`)

| Task                                                       | Requirement   | Status |
| ---------------------------------------------------------- | ------------- | ------ |
| Webhook signature verification                             | FR-20         | ✅     |
| Pull request event parsing                                 | FR-22         | ✅     |
| `RepositoryClient` interface and Octokit implementation    | FR-24, NFR-26 | ✅     |
| Installation-scoped authentication                         | FR-24, NFR-22 | ✅     |
| Bounded retry of transient errors                          | FR-30         | ✅     |
| Mapping GitHub files to review engine input                | FR-24         | ✅     |
| Summary rendering that neutralises contributor-chosen text | FR-25, NFR-25 | ✅     |
| Publishing one comment, updated in place                   | FR-25, FR-26  | ✅     |

### API (`apps/api`)

| Task                                                            | Requirement    | Status |
| --------------------------------------------------------------- | -------------- | ------ |
| Environment configuration validated at start-up                 | NFR-23         | ✅     |
| Structured logging with redaction                               | NFR-23, NFR-24 | ✅     |
| Webhook endpoint: size limit, rate limit, signature, validation | FR-20, NFR-21  | ✅     |
| Delivery deduplication                                          | FR-21          | ✅     |
| Review queue: one per pull request, coalescing, bounded         | NFR-20, NFR-21 | ✅     |
| Review service: skip drafts and closed, stale check, publish    | FR-23, FR-27   | ✅     |
| Repository configuration from the base commit                   | FR-28, FR-29   | ✅     |
| Graceful shutdown                                               | —              | ✅     |
| Production image: unprivileged, read-only                       | —              | ✅     |

### Acceptance

Last run on 2026-10-10 with `docker compose run --rm dev npm run check` (Node.js 25).

| Check                               | Result                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Formatting, build, lint, type-check | Passed                                                                                                                         |
| Tests                               | Passed: 662 tests (engine 358, GitHub client 178, API 126)                                                                     |
| Coverage, statements                | Engine 100%, GitHub client 100%, API 98.7%                                                                                     |
| Audit                               | `npm audit`: no known vulnerabilities                                                                                          |
| Container smoke test                | Passed: health, `401` unsigned, `401` wrong secret, `202` signed, duplicate detected, unprivileged user, read-only file system |
| Real GitHub API                     | Passed; see "Live test" below                                                                                                  |

### External review, 2026-10-10

| Finding                                            | Verdict                          | Outcome                                                                                       |
| -------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| GitHub has no single-file permission               | Incorrect: the permission exists | Kept; verified in the live test (D-028)                                                       |
| No total limit on patch size                       | Valid                            | ✅ 10 million characters per review, enforced on retrieval, mapping and in the engine (D-023) |
| Malformed hunks can verify invented lines          | Valid                            | ✅ Only hunks that match their header verify locations (D-024)                                |
| Rate limits are not retried                        | Valid                            | ✅ Bounded wait and retry; failed reviews can be redelivered (D-025, D-026)                   |
| Stale result can publish between check and comment | Valid                            | ✅ Documents now state the real guarantee (D-027)                                             |

### Live test, 2026-10-10

Run against the real GitHub API with the app `pr-buddy-abhishek-sidnal` installed on the private
repository `pr-buddy-test`, webhooks relayed through smee.io to the API container.

| Scenario                                                          | Result                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Pull request opened with no description and one source file       | ✅ One comment, two findings                                    |
| Description edited                                                | ✅ Same comment updated to one finding                          |
| Commit pushed adding a test file                                  | ✅ Same comment updated to "No findings", naming the new commit |
| `.github/pr-buddy.json` on the base branch, new pull request      | ✅ Configuration applied: rule disabled, severity raised        |
| Configuration read with the single-file permission only           | ✅ Works; no Contents permission needed                         |
| Draft pull request opened                                         | ✅ Skipped, no comment                                          |
| Draft marked ready for review                                     | ✅ Reviewed, one comment                                        |
| Signature verification with the real webhook secret, through smee | ✅ All six deliveries accepted                                  |
| Warnings or errors in the API log                                 | ✅ None                                                         |

Not exercised live: redelivery, rate limits, very large pull requests, a push during a review.
These are covered by automated tests only.

## Milestone 1 — review engine

Complete. Engine, three rules, 348 tests at 100% coverage. Details are in the change log and in
[DESIGN.md](DESIGN.md).

## Open items before going public

| Item                                                              | Owner      |
| ----------------------------------------------------------------- | ---------- |
| Enable private vulnerability reporting in the repository settings | Maintainer |
| Add a contact method for code of conduct reports to the profile   | Maintainer |
| Decide the copyright holder named in `LICENSE`                    | Maintainer |
| Switch the repository from private to public                      | Maintainer |

## Backlog

| Item                                                                 | Milestone |
| -------------------------------------------------------------------- | --------- |
| PostgreSQL: durable delivery memory, review history, organisations   | M3        |
| Durable job queue so queued reviews survive a restart                | M3        |
| Inline review comments, once a rule reports lines                    | M3        |
| Check run with a pass or fail conclusion                             | M3        |
| Rules: debug code, risky configuration changes, change size by lines | M3        |
| AI reviewer behind a provider interface                              | M3        |
| Severity and confidence thresholds                                   | M3        |
| Dashboard: overview, repositories, review details, settings          | M3        |
| YAML repository configuration                                        | M3        |
| Run third-party rules in a worker thread with a hard time limit      | M3        |
| Pin GitHub Actions and base images to digests                        | M4        |
| Release `v0.1.0`                                                     | M4        |

## Change log

| Date       | Change                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 2026-10-10 | Project documentation written; Milestone 1 started                                                                |
| 2026-10-10 | Review engine, three rules, tests and tooling implemented                                                         |
| 2026-10-10 | Replaced picomatch with an own glob matcher after measuring a denial-of-service risk                              |
| 2026-10-10 | Milestone 1 acceptance checks passed; repository published privately on GitHub                                    |
| 2026-10-10 | Milestone 2: GitHub client package, API service, production image, CI image build                                 |
| 2026-10-10 | Milestone 2 merged; dependency bumps merged; TypeScript 7 held back in Dependabot                                 |
| 2026-10-10 | Hardening after an external review: patch budget, stricter patch parser, rate-limit retry, redeliverable failures |
| 2026-10-10 | GitHub App registered and verified live on a test repository; Milestone 2 complete                                |
