# PR Buddy — Context

The fastest way to get oriented, for a new contributor or an AI coding assistant. Read this first.

## What this is

PR Buddy is an open-source assistant that reviews GitHub pull requests and reports a small number
of actionable, evidence-backed findings. Humans keep the merge decision.

## Current state

- **Milestone 7**, runner mode, has its first phase built: PR Buddy as a GitHub Action that runs
  the rules in a repository's own CI (RUNNER.md). It asks no AI model yet; the later phases of
  DESIGN-RUNNER.md are not built.
- **Milestone 6** added the operator's Service page and a command that registers a GitHub App.
- **Milestone 1**, the deterministic review engine, is done.
- **Milestone 2**, the GitHub App, is done. It was verified against the real GitHub API on a
  private test repository on 2026-10-10; results are in the tracker.
- **Milestone 5**, a hosted service, is done and `v0.3.0` is released. An installation
  can store its own AI key; CI publishes the API image, so the example stack runs on a small
  server; a first page lets a new person install the app; a public page says what is stored
  and who runs the service; the review queue is shared fairly between installations; and the
  example stack has nightly backups and alerts (DESIGN-OPERATIONS.md). A public deployment was verified on 2026-10-10.
- **Milestones 3 and 4** are done and `v0.1.0` is released. Milestone 3 added PostgreSQL storage for review history and webhook
  deliveries, seven rules with reporting thresholds and line comments, and the AI reviewer.
- The AI reviewer has five providers (AWS Bedrock, Anthropic, OpenAI, Azure AI Foundry, any
  OpenAI-compatible service). It is off until the operator sets `AI_PROVIDER` and a repository
  sets `ai.enabled`. Bedrock was verified live on 2026-10-10; the others have not been run live.
- With a database, a requested review survives a restart, reviews are deleted after 365 days by
  default, and uninstalling the app deletes that installation's history.
- **Milestone 5** has started: an installation can store its own AI provider and key, encrypted,
  managed by its owners on the settings page. It needs `SECRETS_ENCRYPTION_KEY`.
- The **dashboard** is built: sign-in with GitHub, a read-only API limited to the installations
  a person can access, and a React app (`apps/web`) in the Graphite / Signal Lime design. It is
  off unless the database and three settings are present. Sign-in was verified against real
  GitHub on 2026-10-10, on a local run.
- Live status: [TRACKER.md](TRACKER.md).

## Where things are

| Path                                             | Contents                                                      |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `packages/review-engine/src/index.ts`            | Public API of the engine                                      |
| `packages/review-engine/src/rules/`              | Rule contract, registry, built-in rules                       |
| `packages/review-engine/src/limits.ts`           | Every size and time limit of the engine                       |
| `packages/ai-reviewer/src/`                      | Optional AI review: prompt, provider interface, output checks |
| `packages/github-client/src/api/`                | `RepositoryClient` interface and its Octokit implementation   |
| `packages/github-client/src/webhook/`            | Signature verification and event parsing                      |
| `packages/github-client/src/output/`             | The summary comment: rendering and publishing                 |
| `apps/api/src/main.ts`                           | Entry point; the only place real clients are created          |
| `apps/api/src/modules/github/webhook.router.ts`  | The webhook endpoint                                          |
| `apps/api/src/modules/reviews/review.service.ts` | Fetch, review, publish                                        |
| `apps/api/src/modules/auth/`                     | Sign-in, sessions and the session cookie                      |
| `apps/api/src/modules/history/`                  | The read API; every query limited to the session              |
| `apps/web/src/`                                  | The dashboard: pages, shared components, design tokens        |
| `apps/api/tests/helpers/fake-github.ts`          | The in-memory GitHub used by tests                            |
| `examples/prbuddy.config.json`                   | Example configuration, loaded by a test                       |
| `.env.example`                                   | The API's environment variables                               |

## Documents

| Document                                   | Read it for                                                       |
| ------------------------------------------ | ----------------------------------------------------------------- |
| [PRD.md](PRD.md)                           | What is being built and why; requirements and acceptance criteria |
| [ARCHITECTURE.md](ARCHITECTURE.md)         | Packages, modules and the rules for dependencies                  |
| [DESIGN.md](DESIGN.md)                     | Review engine: data contracts, pipeline, limits                   |
| [DESIGN-GITHUB.md](DESIGN-GITHUB.md)       | GitHub App: webhook, queue, review service, permissions           |
| [DESIGN-STORAGE.md](DESIGN-STORAGE.md)     | Database schema, what is and is not stored, migrations            |
| [DESIGN-AI.md](DESIGN-AI.md)               | AI reviewer: what is sent, how replies are checked, limits        |
| [DESIGN-DASHBOARD.md](DESIGN-DASHBOARD.md) | Sign-in, sessions, the read API, the web application              |
| [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md)       | Colours, type, components and the rules every screen follows      |
| [GITHUB_APP.md](GITHUB_APP.md)             | Registering the app and running the API                           |
| [DEPLOYMENT.md](DEPLOYMENT.md)             | Running on a server over HTTPS; upgrade, backup, what is exposed  |
| [DESIGN-AI-KEYS.md](DESIGN-AI-KEYS.md)     | An installation's own AI key: who may set it, encryption, routes  |
| [RULES.md](RULES.md)                       | Reference for each built-in review rule                           |
| [SECURITY.md](SECURITY.md)                 | Threat model and controls                                         |
| [BRAIN.md](BRAIN.md)                       | Decisions and their reasons, glossary, open questions             |
| [TRACKER.md](TRACKER.md)                   | Status of every task                                              |
| [RELEASING.md](RELEASING.md)               | How a release is made: clean-checkout check, tag, notes           |
| [../CHANGELOG.md](../CHANGELOG.md)         | What each version adds, what was verified, known limits           |
| [../CONTRIBUTING.md](../CONTRIBUTING.md)   | Coding rules and the workflow for changes                         |

## Commands

Node.js runs inside Docker; nothing is installed on the host.

```bash
docker compose run --rm dev npm install
```

```bash
docker compose run --rm dev npm run check
```

| Script                  | Does                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `npm run check`         | Format check, build, lint, type-check, tests with coverage |
| `npm run build`         | Compile every package, in dependency order                 |
| `npm test`              | Tests once                                                 |
| `npm run test:coverage` | Tests with a coverage report                               |
| `npm run lint`          | ESLint                                                     |
| `npm run typecheck`     | TypeScript without emitting                                |
| `npm run format`        | Prettier, writing changes                                  |

Packages import each other's compiled output. After changing `review-engine` or `github-client`,
run `npm run build` before linting or testing a package that depends on it.

With Node.js 22.12 or newer installed locally, the same scripts work without the
`docker compose run --rm dev` prefix.

## Rules that must not be broken

1. The engine does no I/O: no file system, network, process or environment access in
   `packages/review-engine/src`.
2. Nothing from a reviewed repository is ever executed, checked out or installed.
3. Anything crossing a boundary is `unknown` until a Zod schema has parsed it.
4. Types come from schemas (`z.infer`); do not write a second definition.
5. A finding's file and line are verified against the diff or removed. Never invent one.
6. A finding does not claim more than its evidence supports.
7. Verify a webhook's signature before parsing its body, and treat the body as a trigger only.
8. Only `github-client` imports Octokit. The API uses the `RepositoryClient` interface.
9. Never log pull request titles, descriptions, file names, patches, tokens or secrets.
10. Text a contributor can choose is rendered as code or escaped before it is published.
11. Sizes, timeouts and limits are named constants.
12. Every rule has positive, negative and edge-case tests.
13. Do not build ahead of the current milestone.

## Conventions

- TypeScript strict mode, ES modules, relative imports end in `.js`.
- File names are kebab-case; rules are `<rule-id>.rule.ts`; schemas are `<name>.schema.ts`.
- Rule IDs are kebab-case and never reused for different behaviour.
- Named exports only.
- Tests are in `tests/unit/` and `tests/integration/`; shared test code is in `tests/helpers/`.
- Modules receive their dependencies as arguments; only `main.ts` creates real ones.

## When you finish a change

1. `npm run check` passes.
2. [TRACKER.md](TRACKER.md) reflects the new status.
3. A new decision is recorded in [BRAIN.md](BRAIN.md).
4. A changed rule is updated in [RULES.md](RULES.md) and its `version` is bumped.
5. A new threat or control is recorded in [SECURITY.md](SECURITY.md).
