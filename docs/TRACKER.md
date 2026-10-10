# PR Buddy — Tracker

Status of the work. Update this file in the same change that moves a task.

Legend: ✅ done · 🚧 in progress · ⬜ not started

## Milestones

| Milestone | Deliverable                                         | Status                   |
| --------- | --------------------------------------------------- | ------------------------ |
| M1        | Deterministic review engine                         | ✅                       |
| M2        | GitHub App integration                              | ✅                       |
| M3        | Storage, rules and thresholds, AI review, dashboard | 🚧 a live AI run is left |
| M4        | Hardening and `v0.1.0`                              | ⬜                       |

## Milestone 3, part 4 — the dashboard

Design: [DESIGN-DASHBOARD.md](DESIGN-DASHBOARD.md) and [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).
Visual direction: [ADR 0001](ADR/0001-visual-direction.md).

| Task                                                            | Requirement           | Status |
| --------------------------------------------------------------- | --------------------- | ------ |
| Requirements, design and decisions D-049 to D-059               | —                     | ✅     |
| Sign-in with GitHub, protected by a state value                 | FR-70, NFR-71, NFR-73 | ✅     |
| Sessions in PostgreSQL, stored as a hash, 8 hours               | NFR-72                | ✅     |
| Read API limited in SQL to the session's installations          | FR-71, NFR-70         | ✅     |
| Review history across repositories, filtered by outcome         | FR-73                 | ✅     |
| Web application served by the API under a strict CSP            | FR-77, NFR-76         | ✅     |
| Design system: tokens, light and dark themes, shared components | —                     | ✅     |
| Shell, overview, repositories, history, review detail, settings | FR-72 to FR-76        | ✅     |
| Out-of-date marker on a review that has been superseded         | —                     | ✅     |
| Dashboard off unless fully configured                           | NFR-75                | ✅     |
| Sign-in against real GitHub                                     | FR-70                 | ✅     |

### Acceptance

| Check                        | Result                                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`              | Passed: 1,279 tests (engine 474, AI reviewer 93, GitHub client 236, API 356, web 120)                                                                                                                          |
| Tenant isolation             | Passed: two tenants in one database; every route tried with the other tenant's IDs answers `404`, the same as a missing ID                                                                                     |
| Production image             | Passed: migration `0004` applied at start-up; the page is served with the Content-Security-Policy and no inline script; fonts load from the same origin                                                        |
| Browser, real stored reviews | Passed with a session row created by hand in the development database: all six routes in the dark and light themes; no console CSP errors                                                                      |
| Narrow screens               | Passed at 375 px on every route in both themes: no horizontal overflow, no text below 12 px                                                                                                                    |
| Deep links                   | Passed: `?finding=2` restores the selected finding; `?status=` restores the history filter                                                                                                                     |
| Sign-in against real GitHub  | Passed on 2026-10-10: the maintainer signed in through the app `pr-buddy-abhishek-sidnal` at `http://localhost:3000`; the log recorded the sign-in with one installation, and the session was stored as a hash |
| Keyboard and screen reader   | Checked in tests by role and accessible name; not walked through by hand with a screen reader                                                                                                                  |

Left out on purpose, with reasons, in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) section 6: the pull
request queue, titles and authors, diffs, AI suggestion text, "re-run review", editable rules and
settings.

## Milestone 3, part 3 — the AI reviewer

Design: [DESIGN-AI.md](DESIGN-AI.md). Five providers are included (AWS Bedrock, Anthropic, OpenAI,
Azure AI Foundry, any OpenAI-compatible service). Nothing is sent anywhere until the operator sets
`AI_PROVIDER` and a repository opts in.

| Task                                                            | Requirement           | Status |
| --------------------------------------------------------------- | --------------------- | ------ |
| Requirements, design and decisions D-041 to D-048               | —                     | ✅     |
| Package `@pr-buddy/ai-reviewer` with the `AiProvider` interface | FR-60, FR-67          | ✅     |
| Repository switch `ai.enabled`, read at the base commit         | FR-61                 | ✅     |
| File selection, budgets and the prompt                          | FR-62, NFR-60, NFR-63 | ✅     |
| Reply parsing and verification against the files sent           | NFR-61, NFR-62        | ✅     |
| One request with a time limit, no retry                         | NFR-64                | ✅     |
| Suggestions in their own section of the comment                 | FR-63, FR-64, NFR-67  | ✅     |
| Thresholds apply to suggestions                                 | FR-65                 | ✅     |
| Failure never fails the review                                  | NFR-65                | ✅     |
| `ai_reviews` table, without suggestion text                     | FR-66, NFR-66         | ✅     |
| Providers: Bedrock, Anthropic, OpenAI, Azure, OpenAI-compatible | FR-60, FR-68          | ✅     |
| A provider run against its real service                         | FR-60                 | ⬜     |

### Acceptance

| Check                    | Result                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`          | Passed: 1,385 tests (engine 474, AI reviewer 186, GitHub client 236, API 369, web 120)                                                                                                       |
| AWS request signing      | Passed: reproduces the signing key and the signature AWS publishes for its example request                                                                                                   |
| Canary tests             | Passed: prompt text, reply text and provider error messages reach neither the logs nor the stored record                                                                                     |
| Migration `0003`         | Applied at start-up on the running database, in the read-only container                                                                                                                      |
| Live run, no provider    | Passed: `pr-buddy-test#3` reopened and reviewed as before; no AI fields in the log, no row in `ai_reviews`, line comments not repeated                                                       |
| Live run with a provider | Not yet run: it needs the operator's credentials for a provider. How well the instructions resist prompt injection against a real model is unmeasured; the output checks do not depend on it |

## Milestone 3, part 2 — rules, thresholds and line comments

| Task                                                 | Requirement           | Status |
| ---------------------------------------------------- | --------------------- | ------ |
| Requirements and decisions D-035 to D-040            | —                     | ✅     |
| Patch parser keeps the text of added lines           | FR-58                 | ✅     |
| Rule `max-changed-lines`                             | FR-50                 | ✅     |
| Rule `debug-statements`                              | FR-51, NFR-50, NFR-54 | ✅     |
| Rule `credential-files`                              | FR-52                 | ✅     |
| Rule `sensitive-file-changes`                        | FR-53                 | ✅     |
| Reporting thresholds in the engine                   | FR-54                 | ✅     |
| Hidden-finding count in the comment and the database | FR-55                 | ✅     |
| Line comments, reconciled by fingerprint             | FR-56, FR-57, NFR-52  | ✅     |
| Line-comment failures do not fail a review           | NFR-53                | ✅     |

### Acceptance

| Check                         | Result                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`               | Passed: 894 tests (engine 469, GitHub client 208, API 217)                                                                                                                                         |
| Live run on `pr-buddy-test#3` | Passed: two debug statements pushed, two line comments appeared on the right lines; re-reviewing the same commit added none; removing one statement deleted exactly its comment and kept the other |
| Migration `0002`              | Applied at start-up on the running database                                                                                                                                                        |

Not exercised live: thresholds from a repository file, the 20-comment cap, a failed line-comment call. These are covered by automated tests only.

## Milestone 3, part 1 — storage

| Task                                                               | Requirement          | Status |
| ------------------------------------------------------------------ | -------------------- | ------ |
| Storage design, requirements, threats and decisions D-029 to D-034 | —                    | ✅     |
| Schema and first migration                                         | FR-40, FR-41         | ✅     |
| Migration runner: one transaction, advisory lock, checksums        | FR-43                | ✅     |
| Connection pool with transactions                                  | NFR-41, NFR-43       | ✅     |
| Delivery store in PostgreSQL                                       | FR-42                | ✅     |
| Review store in PostgreSQL                                         | FR-40, FR-41, NFR-40 | ✅     |
| Review service records completed, skipped and failed reviews       | FR-40, NFR-44        | ✅     |
| Service runs without a database                                    | FR-44                | ✅     |
| Readiness endpoint                                                 | FR-45                | ✅     |
| Development database in Compose; PostgreSQL service in CI          | NFR-46               | ✅     |

### Acceptance

| Check                               | Result                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                     | Passed: 734 tests (engine 358, GitHub client 178, API 198)                                                                                         |
| Storage tests against PostgreSQL 17 | Passed, including concurrent claims and concurrent migrations                                                                                      |
| Live run                            | Passed: migration applied at start-up in the read-only container; a real review of `pr-buddy-test#2` was stored with its finding and rule versions |
| Stored content                      | Verified by test: no title, description or patch reaches the database                                                                              |

### Next parts of Milestone 3

| Part                 | Contents                                          |
| -------------------- | ------------------------------------------------- |
| Rules and thresholds | Done; see part 2 above                            |
| AI reviewer          | Done except for a real provider; see part 3 above |
| Dashboard            | Done; see part 4 above                            |

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

| Item                                                                                | Milestone |
| ----------------------------------------------------------------------------------- | --------- |
| Retention limit for stored reviews                                                  | M3        |
| Durable job queue so queued reviews survive a restart                               | M3        |
| Check run with a pass or fail conclusion                                            | M3        |
| AWS credentials from roles, profiles or single sign-on (needs the SDK or more code) | Later     |
| Line comments for AI suggestions, with a fingerprint that survives rewording        | M3        |
| Per-repository AI budget and usage report                                           | M3        |
| Dashboard: editing settings, roles within an installation, charts                   | Later     |
| YAML repository configuration                                                       | M3        |
| Run third-party rules in a worker thread with a hard time limit                     | M3        |
| Revoke dashboard access as soon as GitHub does, from installation webhooks          | M4        |
| Browser test of the dashboard and of sign-in against real GitHub in CI              | M4        |
| Pin GitHub Actions and base images to digests                                       | M4        |
| Release `v0.1.0`                                                                    | M4        |

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
| 2026-10-10 | Milestone 3 started: PostgreSQL storage for review history and webhook deliveries                                 |
| 2026-10-10 | Four rules, reporting thresholds and reconciled line comments; verified live                                      |
| 2026-10-10 | AI reviewer package, repository switch, comment section and storage; no real provider yet                         |
| 2026-10-10 | Dashboard: sign-in with GitHub, sessions, read API, React app in the Graphite / Signal Lime design system         |
| 2026-10-10 | Dashboard sign-in verified against real GitHub                                                                    |
| 2026-10-10 | AI providers: Bedrock (with own request signing), Anthropic, OpenAI, Azure AI Foundry, OpenAI-compatible          |
