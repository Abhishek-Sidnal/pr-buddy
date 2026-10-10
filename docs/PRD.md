# PR Buddy — Product Requirements

|                        |                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Status                 | Milestone 1 in progress                                                                                             |
| Scope of this document | Product vision, and detailed requirements for Milestone 1                                                           |
| Related                | [ARCHITECTURE.md](ARCHITECTURE.md) · [DESIGN.md](DESIGN.md) · [SECURITY.md](SECURITY.md) · [TRACKER.md](TRACKER.md) |

## 1. Problem

Manual code review costs engineering time, and its quality varies from reviewer to reviewer.
Automated reviewers exist, but they tend to post many comments of uneven value, so teams learn to
ignore them.

## 2. Product

PR Buddy is an open-source assistant that reviews GitHub pull requests. It reports a small number
of actionable findings, explains the evidence behind each one, and leaves the merge decision to
people.

**Promise:** catch actionable problems early, explain why they matter, and keep the team in
control of its code.

## 3. Users

| User                                     | What they need                                    |
| ---------------------------------------- | ------------------------------------------------- |
| Small teams on GitHub                    | A consistent first-pass review on every PR        |
| Startups on React / Node.js / TypeScript | Checks that fit their stack out of the box        |
| Engineering leads                        | Team conventions enforced the same way every time |
| Individual developers                    | Feedback before a human reviewer spends time      |

## 4. Product principles

1. **Low noise.** A finding that is not actionable should not be reported.
2. **Evidence, not opinion.** Every finding states the facts it is based on.
3. **Honest claims.** A finding never says more than its evidence supports.
4. **Deterministic first.** Predictable checks come before AI suggestions, and the two are always
   distinguishable.
5. **Human-controlled.** PR Buddy never merges or changes code in V1.
6. **Self-hostable and transparent.** The review logic is open and configurable.

## 5. Roadmap

| Version | Theme                       | Contents                                                                                                         |
| ------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| V1      | Reliable PR reviewer        | GitHub App, webhooks, deterministic rules, optional AI review, inline comments, review history, repository rules |
| V1.5    | Team workflow               | CI integration, severity thresholds, dashboards, custom rules, notifications, feedback tracking                  |
| V2      | Context-aware reviewer      | Repository indexing, cross-file analysis, architectural rules                                                    |
| V3      | Controlled merge automation | Optional merge orchestration behind explicit approvals and passing checks                                        |

V1 is delivered in milestones:

| Milestone | Deliverable                                                          |
| --------- | -------------------------------------------------------------------- |
| **M1**    | Framework-independent deterministic review engine (this document)    |
| M2        | GitHub App: webhook verification, diff fetching, publishing a review |
| M3        | Optional AI reviewer, policy thresholds, minimal dashboard           |
| M4        | Hardening, documentation, `v0.1.0` release                           |

## 6. Milestone 1 — the review engine

### 6.1 Objective

A library that takes a description of a pull request and returns validated, structured findings.
It has no knowledge of GitHub, HTTP, databases or AI, so it can be tested with fixtures and reused
by the GitHub App, a CLI or any other integration.

### 6.2 Functional requirements

| ID    | Requirement                                                                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | Shared types exist for `ReviewContext`, `ReviewRule`, `ReviewFinding` and `Severity`.                                             |
| FR-2  | Rules are registered in an extensible registry; third parties can add rules without changing the engine.                          |
| FR-3  | Rule `pr-description` flags a missing or insufficient PR description.                                                             |
| FR-4  | Rule `max-changed-files` flags a PR that changes more files than a configured maximum.                                            |
| FR-5  | Rule `missing-test-changes` flags a PR that changes source files but no test files, based on configurable repository conventions. |
| FR-6  | Every rule has an identifier, version, description, default severity and an options schema.                                       |
| FR-7  | Findings are structured: rule ID, severity, confidence, message, evidence, and optional file, line and suggestion.                |
| FR-8  | A rule can be disabled, have its severity overridden and receive per-rule options.                                                |
| FR-9  | All configuration is validated at runtime; invalid configuration fails with a message that names the faulty field.                |
| FR-10 | All review input is validated at runtime before any rule runs.                                                                    |
| FR-11 | A file or line reference that cannot be verified against the diff is removed from the finding, and the removal is reported.       |
| FR-12 | One failing rule does not prevent the other rules from reporting.                                                                 |

### 6.3 Non-functional requirements

| ID    | Requirement                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------- |
| NFR-1 | TypeScript with strict compiler settings.                                                           |
| NFR-2 | Unit tests with Vitest: positive, negative, malformed-input and edge cases for every rule.          |
| NFR-3 | Fixtures cover additions, deletions, renames and empty diffs.                                       |
| NFR-4 | The engine never executes, imports or evaluates code from a reviewed repository.                    |
| NFR-5 | The engine performs no file, network or process I/O.                                                |
| NFR-6 | Output is deterministic: the same input and configuration give the same findings in the same order. |
| NFR-7 | Input sizes are bounded so a hostile pull request cannot exhaust memory or CPU.                     |
| NFR-8 | Runtime dependencies are kept to the minimum.                                                       |

### 6.4 Out of scope for Milestone 1

GitHub App, webhooks, database, dashboard, AI review, background jobs, YAML configuration files,
languages other than JavaScript and TypeScript, automatic merging and automatic code changes.

### 6.5 Acceptance criteria

- `npm run check` passes: formatting, lint, type-check, tests and build.
- Each built-in rule has positive, negative and edge-case tests.
- Malformed contexts and malformed configuration are rejected with useful errors.
- Fixtures for added, deleted, renamed and empty diffs produce the expected findings.
- The example configuration in `examples/` is loaded by a test.
- No finding states that tests are absent; the test rule reports a signal only.
- A new developer can install and run the tests from the README.

Progress against these criteria is tracked in [TRACKER.md](TRACKER.md).

## 6A. Milestone 2 — the GitHub App

### Objective

A pull request in a repository where the app is installed is reviewed automatically, and the
result appears as one comment on that pull request. Design: [DESIGN-GITHUB.md](DESIGN-GITHUB.md).

### Functional requirements

| ID    | Requirement                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-20 | The app receives pull request webhooks and rejects any whose signature is invalid.                                                                                                                                                   |
| FR-21 | A repeated webhook delivery does not cause a second review.                                                                                                                                                                          |
| FR-22 | Opening, reopening, pushing to, editing or marking ready a pull request triggers a review.                                                                                                                                           |
| FR-23 | Draft and closed pull requests are not reviewed.                                                                                                                                                                                     |
| FR-24 | Changed files and patches are fetched with credentials scoped to the installation.                                                                                                                                                   |
| FR-25 | The review is published as a single comment that is updated in place on later reviews.                                                                                                                                               |
| FR-26 | A pull request with no findings receives no comment, unless an earlier comment must be corrected.                                                                                                                                    |
| FR-27 | The head commit is checked immediately before publishing, and a review of an older commit is discarded. A push in the instant between that check and publishing can still slip through; the review it triggers corrects the comment. |
| FR-28 | A repository can configure the rules with `.github/pr-buddy.json` on its base branch.                                                                                                                                                |
| FR-29 | Invalid repository configuration falls back to defaults and is reported in the comment.                                                                                                                                              |
| FR-30 | Transient GitHub errors and short rate limits are retried a bounded number of times; other failures are logged and can be redelivered.                                                                                               |

### Non-functional requirements

| ID     | Requirement                                                                           |
| ------ | ------------------------------------------------------------------------------------- |
| NFR-20 | The webhook is acknowledged before the review runs.                                   |
| NFR-21 | Request size, request rate, concurrency and queue length are all bounded.             |
| NFR-22 | The app requests the fewest GitHub permissions that these features need.              |
| NFR-23 | Secrets come from the environment and never appear in logs, errors or responses.      |
| NFR-24 | Pull request content is never logged.                                                 |
| NFR-25 | Text chosen by a contributor cannot create mentions, links or HTML in the comment.    |
| NFR-26 | Every review flow is tested without network access, against an in-memory GitHub fake. |

### Out of scope for Milestone 2

Database and review history, dashboard, AI review, inline comments, check runs, YAML
configuration, organisations and user accounts, hosted deployment.

### Acceptance criteria

- `npm run check` passes for every package.
- Invalid signatures are rejected; duplicate deliveries do not produce duplicate reviews.
- A new commit during a review prevents the stale result from being published.
- Large, deleted, binary and patch-less files are handled without error.
- Rate limits, permission failures and transient errors from GitHub are handled.
- The API starts in its container and answers a signed webhook.
- **Manual:** a pull request in a real test repository receives exactly one comment, which is
  updated when the pull request changes. This needs a registered GitHub App; see
  [GITHUB_APP.md](GITHUB_APP.md).

## 6B. Milestone 3, part 1 — storage

Milestone 3 is delivered in parts: storage, then rules and thresholds, the AI reviewer, and the
dashboard. This section covers storage. Design: [DESIGN-STORAGE.md](DESIGN-STORAGE.md).

### Functional requirements

| ID    | Requirement                                                                              |
| ----- | ---------------------------------------------------------------------------------------- |
| FR-40 | Every review attempt is recorded: completed, skipped or failed.                          |
| FR-41 | A completed review's findings and the version of each rule that ran are recorded.        |
| FR-42 | Webhook deliveries are remembered in the database, across restarts and across instances. |
| FR-43 | The database schema is created and upgraded automatically when the service starts.       |
| FR-44 | The service runs without a database, as before, when none is configured.                 |
| FR-45 | A readiness endpoint reports whether the database can be reached.                        |

### Non-functional requirements

| ID     | Requirement                                                                       |
| ------ | --------------------------------------------------------------------------------- |
| NFR-40 | Pull request titles, descriptions, patches and file contents are never stored.    |
| NFR-41 | Every statement is parameterised; no SQL is built from input.                     |
| NFR-42 | Every review is tied to an installation, so reads can later be limited by tenant. |
| NFR-43 | A review and its findings are written atomically.                                 |
| NFR-44 | A storage failure never loses or blocks the comment on a pull request.            |
| NFR-45 | The database password never appears in logs or errors.                            |
| NFR-46 | Storage is tested against a real PostgreSQL.                                      |

### Out of scope for this part

Reading history over HTTP, sign-in, organisations and users, retention limits, a durable job
queue, the dashboard.

## 7. Success metrics (from M2 onward)

These cannot be measured until PR Buddy reviews real pull requests.

| Metric                                            | Why it matters                             |
| ------------------------------------------------- | ------------------------------------------ |
| Share of findings accepted as useful by reviewers | The direct measure of "low noise"          |
| Duplicate findings per review                     | Noise                                      |
| Review latency                                    | Usefulness inside the PR workflow          |
| AI cost per review                                | Sustainability of the optional AI reviewer |

## 8. Risks

| Risk                                    | Mitigation                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| Heuristic rules produce false positives | Rules are configurable, report confidence, and word findings as signals          |
| Scope creep delays the first release    | Milestones with explicit out-of-scope lists                                      |
| Hostile PR content attacks the reviewer | Input validation, size limits, no code execution; see [SECURITY.md](SECURITY.md) |
