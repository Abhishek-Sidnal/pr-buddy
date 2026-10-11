# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PR Buddy is an open-source GitHub App that reviews pull requests with deterministic rules and
keeps one summary comment on each pull request up to date. It never merges or changes code.
Milestones 1 (review engine) and 2 (GitHub App) are built, and so are four parts of Milestone 3:
PostgreSQL storage for review history, more rules with thresholds and line comments, an optional
AI reviewer with five model providers, and a dashboard (sign-in with GitHub, a read-only API
and the React app in `apps/web`). Current status is in `docs/TRACKER.md`.

## Commands

Node.js is not installed on the host. Every npm command runs in the `dev` container:

```bash
docker compose run --rm dev npm install
docker compose run --rm dev npm run check     # format:check, build, lint, typecheck, test:coverage
docker compose run --rm dev npm run build     # all packages, in dependency order
docker compose run --rm dev npm run lint
docker compose run --rm dev npm run format    # Prettier, writes changes
docker compose run --rm dev npm test
```

One package, one file, or one test by name:

```bash
docker compose run --rm dev npm test -w @pr-buddy/api
docker compose run --rm dev npm test -w @pr-buddy/api -- tests/unit/review.service.test.ts
docker compose run --rm dev npm test -w @pr-buddy/api -- tests/unit/review.service.test.ts -t "skips a draft"
```

Workspace names: `@pr-buddy/review-engine`, `@pr-buddy/ai-reviewer`, `@pr-buddy/github-client`,
`@pr-buddy/api`, `@pr-buddy/web`.

Run the API itself (needs `.env`, see `docs/GITHUB_APP.md`):

```bash
docker compose --profile app up --build api
```

The running API uses a built image: after changing code, pass `--build`, or the container keeps
the old code. The example production stack in `deploy/` is a separate Compose project
(`prbuddy-deploy`); see `docs/DEPLOYMENT.md`. Never give it the development project's name: the
two would share containers and the database volume.

Things that will trip you up:

- **Build before lint, type-check or tests.** Packages import each other's compiled `dist/`, not
  source. After editing `review-engine` or `github-client`, run `npm run build` or dependants see
  the old code. `npm run check` does this in the right order.
- **Shell quoting.** From PowerShell, inner double quotes in `sh -c "..."` are stripped. Use Git
  Bash with `MSYS_NO_PATHCONV=1 docker compose run --rm dev sh -c '...'` for anything with pipes
  or quotes.
- **The `dev` container starts PostgreSQL too.** Storage tests need a real server and read
  `TEST_DATABASE_URL`, which `compose.yaml` sets. Each test file works in its own schema.
- **`node_modules` is a Docker volume**, not a host folder (the repo sits in OneDrive). Install
  dependencies only through the container, with `-w <workspace>`.
- **TypeScript stays below 6.1** until typescript-eslint supports newer versions.
- Coverage thresholds in each `vitest.config.ts` fail the run; do not lower them.

## Architecture

Five workspaces with one-way dependencies. `apps/web` depends on none of the others: it talks to
the API over HTTP and is served by it as static files.

```
apps/api ──► packages/github-client ──► packages/review-engine
    └──────► packages/ai-reviewer ─────►┘
```

- **`review-engine`** is pure. It takes a `ReviewContext` (pull request metadata plus changed
  files) and a config object, and returns findings. Pipeline in `src/engine/`: validate input with
  Zod → deep-freeze → run each rule isolated with a time limit → validate each finding → verify
  file and line against the diff (unverifiable locations are removed, not the finding) → dedupe
  and sort. Rules return drafts; the engine stamps `ruleId` and severity. ESLint forbids `fs`,
  network, `process`, `eval` and dynamic `import()` in `packages/review-engine/src`; do not
  suppress it.
- **`ai-reviewer`** is optional and inert without a provider. It selects what may be sent, builds
  the prompt, asks an `AiProvider` once with a time limit, and keeps only suggestions it can
  verify against the files it sent. It never throws for a provider problem; it returns a status.
  Tests use `createScriptedProvider`. Real providers are in `src/providers/`, one file each over
  `fetch` with no vendor SDK (D-060); an error reply becomes `ProviderHttp<status>` and its body
  is never read (D-062). The operator picks one with `AI_PROVIDER`; `AI_MODEL` has no default.
- **`apps/web`** is the dashboard: React, React Router and plain CSS driven by the tokens in
  `src/styles/tokens.css`. Shared components are in `src/components/`; reuse them. The rules are
  in `docs/DESIGN-SYSTEM.md`. It is tested with Testing Library against a fake `fetch`.
- In **`api`**, `modules/auth` holds sign-in and sessions, `modules/history` the read API, and
  `modules/web` serves the built dashboard. All three exist only when the dashboard is configured.
  `modules/ai-keys` stores an installation's own AI key and exists only with a master key.
- **`github-client`** is the only package that knows GitHub: signature verification, event
  parsing, the `RepositoryClient` interface and its Octokit implementation, mapping GitHub files
  to engine input, and rendering and publishing the summary comment.
- **`api`** wires them together. `main.ts` is the only file that reads the environment or creates
  real clients; everything else takes its dependencies as arguments. It depends on the
  `RepositoryClient` interface, never on Octokit, which is why tests use the in-memory
  `apps/api/tests/helpers/fake-github.ts`.

Request flow: `POST /webhooks/github` → rate limit and 1 MB body limit → HMAC signature over the
raw body → delivery-ID dedupe → parse event → enqueue → `202`. The queue runs one review at a time
per pull request and coalesces waiting ones. The review service then fetches the pull request,
files and config, runs the engine, re-fetches to check the head commit has not moved, and creates
or updates the comment.

## Invariants

These are design decisions with reasons recorded in `docs/BRAIN.md` (D-001 to D-095). Read the
relevant entry before changing one.

- A webhook body is only a trigger. What gets reviewed is fetched from the API.
- Verify the signature before parsing anything in the body.
- Repository config (`.github/pr-buddy.json`) is read at the pull request's **base** commit, so a
  contributor cannot relax checks on their own pull request.
- Nothing from a reviewed repository is executed, checked out or installed.
- Types are inferred from Zod schemas (`z.infer`); never hand-write a second definition.
- A finding never claims more than its evidence shows. `missing-test-changes` is a signal, not
  proof, and its wording and 0.6 confidence reflect that.
- Never invent a file or line for a finding.
- A rule never copies source text into a finding: findings are stored and published, source is
  not (D-035). A rule that matches text or names reports a confidence below 1 (D-036).
- Line comments are reconciled by fingerprint; only the app's own marked comments are ever
  deleted (D-039). They are best-effort: a failure there must not fail the review (D-040).
- AI review needs both a provider from the operator and `ai.enabled` from the repository, read
  at the base commit; any invalid configuration means it is off (D-042).
- Model output is untrusted input. The model never sets confidence (fixed 0.5), rule ID or
  evidence, cannot report `critical`, and a suggestion whose file or line was not sent is dropped
  whole (D-043, D-044). Suggestions go in the summary only, never as line comments (D-045).
- Never log or store prompt text, reply text, suggestion text or a provider's error message; the
  error's name only (D-046, D-048). An AI failure must not fail a review.
- Every dashboard query is limited **in SQL** to the installations of the session, and a hidden
  row answers `404` like a missing one (D-054). New read methods take `installationIds` first.
- No GitHub user token is stored, logged or sent to the browser; session tokens are stored only
  as a SHA-256 (D-049, D-051). The dashboard reads history and can change one thing, an
  installation's own AI key (D-056, D-075).
- An installation's AI key is encrypted before it reaches SQL, bound to its installation and
  provider, never returned by any route and never logged (D-073). Only an owner may change it,
  and writes need the dashboard's `Origin` and the `X-PR-Buddy-Request` header (D-072, D-075).
  Customers pick a fixed provider, never an address; Azure is named by resource (D-074, D-080).
  A review whose installation key fails does not fall back to the operator's provider (D-078).
- `GET /auth/service` is the only route with data that needs no session. It answers what the
  operator configured for the public (app name, who runs the service, retention) and takes no
  input (D-083, D-090). Links made from those values are checked again in the browser
  (`github-links.ts`, `operator-links.ts`).
- The privacy page's statements about the software are fixed text kept with the code; change
  them in the same change as the behaviour they describe. Statements about the operator come
  only from settings, and "not published" is said, never hidden (D-090, D-091).
- The operator's view reads across installations on purpose. Its queries live in
  `modules/operator`, reachable only through a router that checks the session's GitHub user ID
  against `OPERATOR_GITHUB_USER_IDS` and answers `404` otherwise. It returns account names and
  counts, never a repository name, pull request, finding, file path, login or key (D-092, D-093).
- `cli/register-app.ts` is a second entry point. It never prints a secret, and the pages it
  serves never contain one (D-094).
- Every queued review carries its installation. The queue is shared fairly between
  installations and one installation's waiting reviews are capped (D-089).
- Backups and alerts are scripts in `deploy/`, not part of the API. A backup never contains
  `deploy/.env`; the server's credential may only write backups and publish alerts; an alert
  names the site and the failing checks and nothing about what was reviewed (D-086 to D-088).
- The dashboard shows only what the service can back: no sample data, no control that does
  nothing (D-058). Web code uses design tokens, never raw colours; every API answer is parsed
  with a Zod schema; stored text is rendered as text; GitHub links go through
  `apps/web/src/github-links.ts`.
- Text a contributor can choose (file names, config keys) is published as inline code or escaped;
  see `github-client/src/output/markdown.ts`.
- Never log pull request titles, bodies, file names, patches, tokens or secrets. Tests assert this
  with canary strings.
- Globs use the project's own matcher (`review-engine/src/utils/glob.ts`), not a library: a
  regex-based one hung for 26 seconds on a hostile pattern (D-011). Keep matching free of regular
  expressions and recursion.
- The database stores identifiers, findings, counts and timings. Never store pull request titles,
  descriptions, patches, file contents or error messages (D-031).
- SQL is hand-written and always parameterised; there is no ORM (D-029). Schema changes are new
  files in `apps/api/migrations`; an applied migration is never edited.
- The service must keep working without `DATABASE_URL` (D-030), and a storage failure must never
  fail a review whose comment is already posted (D-034).
- A review request is written to `pending_reviews` before its webhook is acknowledged and
  deleted only by the review of the same generation (D-066). Recovery is bounded: three attempts,
  one day (D-067). Rows hold identifiers only.
- Uninstalling the app deletes that installation's history and sessions; every such statement
  is limited to the installation the signed event names (D-069). Reviews are deleted after
  `REVIEW_RETENTION_DAYS` (D-068).
- Sizes and timeouts are named constants (`review-engine/src/limits.ts`), not literals.
- No empty scaffolding: a folder is created when its milestone starts.

## Conventions

- Strict TypeScript, ES modules, relative imports end in `.js`, named exports only, no `any`, no
  non-null `!`.
- Files are kebab-case; rules are `<rule-id>.rule.ts`; schemas are `<name>.schema.ts`.
- Tests live in `tests/unit/` and `tests/integration/` per package, not beside source.
- Adding a rule: create it with `defineRule`, add it to `rules/builtin.ts`, export it from
  `src/index.ts`, test positive, negative, edge and invalid-option cases, document it in
  `docs/RULES.md`. Bump the rule's `version` when behaviour changes.

## Documentation is part of the change

The maintainer wants design documents written before code and kept current. In the same change:

| When you…                           | Update                                                       |
| ----------------------------------- | ------------------------------------------------------------ |
| Start or finish a task              | `docs/TRACKER.md`                                            |
| Make a design decision              | `docs/BRAIN.md` (next `D-0xx` entry)                         |
| Add a threat or a control           | `docs/SECURITY.md`                                           |
| Change a contract, limit or flow    | `docs/DESIGN.md`, `-GITHUB`, `-STORAGE`, `-AI`, `-DASHBOARD` |
| Change how the dashboard looks      | `docs/DESIGN-SYSTEM.md`                                      |
| Add or move a module                | `docs/ARCHITECTURE.md`                                       |
| Change how it is deployed           | `docs/DEPLOYMENT.md`, `deploy/`                              |
| Change a rule                       | `docs/RULES.md`                                              |
| Change what a user or operator sees | `CHANGELOG.md`, under "Unreleased"                           |
| Add an action or a base image       | Pin it to a commit or digest; `scripts/check-pins.sh` checks |

`docs/CONTEXT.md` is the orientation page; `CONTRIBUTING.md` has the full coding rules.

## Git

Work on a branch and open a pull request; `main` is the default branch. CI (`.github/workflows/ci.yml`)
runs the same steps as `npm run check` on Node.js 22 and 24, audits production dependencies and
builds the API image. A second workflow, `publish-image.yml`, pushes that image to GitHub's container
registry for `main` and version tags only (D-082); it is the only job that may write anything.
