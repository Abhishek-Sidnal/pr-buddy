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
| M5        | Hosted service: an installation's own AI key first                   |

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

## 6C. Milestone 3, part 2 — rules, thresholds and inline comments

Until now every rule looked at pull request metadata and file names. This part adds rules that
read the changed lines, a way for a repository to hide low-priority findings, and comments placed
on the lines they are about.

### Functional requirements

| ID    | Requirement                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------- |
| FR-50 | Rule `max-changed-lines` flags a pull request that changes more lines than a configured maximum.    |
| FR-51 | Rule `debug-statements` flags debugging calls on added lines and points at each line.               |
| FR-52 | Rule `credential-files` flags files whose names say they usually hold credentials.                  |
| FR-53 | Rule `sensitive-file-changes` flags changes to files that control builds, deployment or review.     |
| FR-54 | A repository can set a minimum severity and a minimum confidence; findings below either are hidden. |
| FR-55 | The comment says how many findings were hidden by thresholds.                                       |
| FR-56 | A finding with a verified line is also posted as a comment on that line.                            |
| FR-57 | Reviewing again does not repeat a line comment, and removes one whose finding is gone.              |
| FR-58 | Rules can read the text of added lines.                                                             |

### Non-functional requirements

| ID     | Requirement                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------- |
| NFR-50 | No rule copies source text into a finding. Evidence names what was found and where, not the line.   |
| NFR-51 | A rule that matches text reports a confidence below 1, because text can sit in a string or comment. |
| NFR-52 | The number of line comments per review is bounded.                                                  |
| NFR-53 | A failure to post line comments does not fail a review whose summary is already posted.             |
| NFR-54 | Line matching has bounded cost for any line, including very long ones.                              |

### Out of scope for this part

Scanning file contents for secrets (use a dedicated scanner), languages other than JavaScript and
TypeScript for `debug-statements`, check runs, replying to or resolving comment threads.

## 6D. Milestone 3, part 3 — the AI reviewer

Rules find what can be described in advance. This part adds an optional reviewer that asks a
language model for suggestions and keeps them apart from the deterministic findings. Design:
[DESIGN-AI.md](DESIGN-AI.md).

### Functional requirements

| ID    | Requirement                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-60 | An operator can supply a model provider; without one, no pull request content leaves the service.                                             |
| FR-61 | A repository opts in with `ai.enabled` in its configuration, read at the base commit. Default: off.                                           |
| FR-62 | The reviewer sends the title, a bounded description and the visible new-side lines of changed files.                                          |
| FR-63 | Suggestions appear in the summary comment in their own section, labelled as written by a model.                                               |
| FR-64 | The comment names the model and says how many files were not sent.                                                                            |
| FR-65 | The repository's reporting thresholds apply to suggestions.                                                                                   |
| FR-66 | Each AI review is recorded with its model, status, counts, token usage and duration.                                                          |
| FR-67 | A provider is a small interface, so one can be added without changing the reviewer.                                                           |
| FR-68 | The operator chooses a provider and a model in the environment: Bedrock, Anthropic, OpenAI, Azure AI Foundry or an OpenAI-compatible service. |
| FR-69 | A provider setting that is missing or malformed stops the service at start-up and names the variable.                                         |

### Non-functional requirements

| ID     | Requirement                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| NFR-60 | Pull request content is data. It is passed as one JSON document, apart from the instructions.              |
| NFR-61 | Model output is validated entry by entry; a suggestion with an unverifiable location is dropped.           |
| NFR-62 | The model cannot set confidence, rule ID or evidence, and cannot report `critical`.                        |
| NFR-63 | Credential-like files and lockfiles are never sent.                                                        |
| NFR-64 | Prompt size, reply size, output tokens, suggestions and time are bounded; one request, no retry.           |
| NFR-65 | A failed AI review never fails the review; the comment says it could not be completed.                     |
| NFR-66 | Prompt text, reply text and provider error messages are never logged and never stored.                     |
| NFR-67 | Model text is published escaped, so it cannot create links, mentions, images or HTML.                      |
| NFR-68 | A provider's key is never logged, stored or put in an error; a failed reply is reduced to its HTTP status. |
| NFR-69 | Code is sent over HTTPS only, except to a model on the same machine.                                       |

### Out of scope for this part

Line comments for suggestions, sending whole files or the
rest of the repository, follow-up questions to the model, automatic fixes, per-repository budgets.

## 6E. Milestone 3, part 4 — the dashboard

History has been written since part 1 and could only be read with SQL. This part lets a person
sign in and read it. Design: [DESIGN-DASHBOARD.md](DESIGN-DASHBOARD.md).

### Functional requirements

| ID    | Requirement                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------- |
| FR-70 | A person signs in with GitHub. There are no passwords and no accounts to create.                |
| FR-71 | A signed-in person sees the repositories of the installations GitHub says they can access.      |
| FR-72 | An overview shows reviews, findings and failed reviews of the last 30 days, and recent reviews. |
| FR-73 | A repository page lists its reviews, newest first, with paging.                                 |
| FR-74 | A review page shows its outcome, findings with evidence, the rules that ran and the AI record.  |
| FR-75 | Reviews and commits link to GitHub.                                                             |
| FR-76 | A person can sign out.                                                                          |
| FR-77 | The dashboard is served by the API itself and needs no second service.                          |

### Non-functional requirements

| ID     | Requirement                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------- |
| NFR-70 | Every read is limited, in SQL, to the installations of the session. Hidden and missing look alike. |
| NFR-71 | The GitHub user token is used once at sign-in and never stored, logged or sent to the browser.     |
| NFR-72 | Session tokens are random, kept in an `HttpOnly` cookie, and stored only as a hash.                |
| NFR-73 | Sign-in is protected against cross-site request forgery with a `state` value.                      |
| NFR-74 | The dashboard is read-only; its one state-changing request, sign-out, cannot be forged cross-site. |
| NFR-75 | Without its settings the dashboard does not exist and the service runs as before.                  |
| NFR-76 | The browser receives no secrets, renders API data as text only, and runs under a strict CSP.       |
| NFR-77 | Sign-in and read routes are rate limited.                                                          |

### Out of scope for this part

Editing settings in the dashboard, roles within an installation, charts, exporting data, e-mail or
other notifications, retention limits, signing in without GitHub.

## 6F. Milestone 4 — hardening and `v0.1.0`

The features are in place. This milestone makes the service something a stranger can deploy,
keep running and trust, and ends with the first release. It is delivered in parts:

| Part | Contents                                                                        |
| ---- | ------------------------------------------------------------------------------- |
| 1    | Deployment behind HTTPS: an example stack, a deployment guide, start-up checks  |
| 2    | Data lifecycle: a retention limit, and losing dashboard access when GitHub does |
| 3    | Supply chain: actions and base images pinned to digests                         |
| 4    | Release `v0.1.0`: changelog, version, tag                                       |

### Part 1 — deployment behind HTTPS

Until now the service has only run on `http://localhost`. Guide: [DEPLOYMENT.md](DEPLOYMENT.md).

| ID     | Requirement                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------- |
| FR-80  | The repository contains an example stack that serves the API and dashboard over HTTPS.               |
| FR-81  | A guide covers what to set, how to start, upgrade, back up and check the service.                    |
| FR-82  | The service warns at start-up about settings that are valid but unsafe together.                     |
| NFR-80 | Over HTTPS, browsers are told to keep using HTTPS (`Strict-Transport-Security`).                     |
| NFR-81 | In the example stack only the proxy is reachable from outside; the API and database publish no port. |
| NFR-82 | The example stack has no default database password: it refuses to start without one.                 |
| NFR-83 | Behind one proxy, rate limits apply to the visitor's address, not the proxy's.                       |

Out of scope: Kubernetes manifests, managed-database set-up, high availability, metrics.

### Part 2 — data lifecycle and recovery

What the service remembers, for how long, and what happens to work in progress when it stops.
Prompted in part by an external review of Milestone 3. Design:
[DESIGN-STORAGE.md](DESIGN-STORAGE.md), sections 10 to 12.

| ID     | Requirement                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------- |
| FR-83  | A review that was requested but not finished when the service stopped is run after it starts again.      |
| FR-84  | Reviews older than a configurable number of days are deleted. The default is 365; 0 keeps them forever.  |
| FR-85  | When the app is uninstalled, that installation's stored history and sessions are deleted.                |
| FR-86  | When an installation is suspended, or a repository is removed from it, access to that data ends at once. |
| NFR-84 | Recovery is bounded: a review is retried at most three times and only within a day of being requested.   |
| NFR-85 | Recovery, retention and installation changes need the database; without one the service runs as before.  |
| NFR-86 | Deleting old reviews happens in batches and never blocks start-up or a review.                           |

Out of scope: a queue shared by several instances, exactly-once delivery, per-repository
retention, exporting data before deletion.

## 6G. Milestone 5 — a hosted service

Until `v0.1.0` PR Buddy assumed one operator who runs it for their own repositories. This
milestone makes it fit to be run for others. Part 1 is the first thing that needs: letting each
customer bring their own AI provider. Design: [DESIGN-AI-KEYS.md](DESIGN-AI-KEYS.md).

### Part 1 — an installation's own AI key

| ID     | Requirement                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------- |
| FR-90  | An installation can store one AI provider, model and key.                                       |
| FR-91  | Reviews of that installation's repositories use it in place of the operator's provider.         |
| FR-92  | Only the account's owner, or an owner of the organisation, can set, replace or remove the key.  |
| FR-93  | The settings page shows each installation's provider, model and the key's last four characters. |
| FR-94  | A key is checked with the provider before it is stored, and a refused key is reported at once.  |
| FR-95  | Customers choose among Anthropic, OpenAI, AWS Bedrock and Azure; they cannot enter an address.  |
| FR-96  | An owner can test the stored key at any time and is told whether the provider accepts it.       |
| NFR-90 | Keys are encrypted at rest with a master key that is not in the database.                       |
| NFR-91 | No API returns a stored key. Keys are never logged.                                             |
| NFR-92 | Requests that change something cannot be forged from another site.                              |
| NFR-93 | Every change is recorded with who made it and when, without the key.                            |
| NFR-94 | A failing customer key never causes code to be sent to the operator's provider instead.         |
| NFR-95 | Uninstalling the app deletes the key.                                                           |
| NFR-96 | Without `SECRETS_ENCRYPTION_KEY` the feature does not exist and the service runs as before.     |

Out of scope: a key per repository, usage or spending reports, providers that need an address
(Azure is reached by resource name), a key service such as AWS KMS (the interface allows it), teams and billing.

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
