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
