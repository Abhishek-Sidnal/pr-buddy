# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PR Buddy is an open-source GitHub App that reviews pull requests with deterministic rules and
keeps one summary comment on each pull request up to date. It never merges or changes code.
Milestones 1 (review engine) and 2 (GitHub App) are built, and so is the first part of Milestone 3:
PostgreSQL storage for review history. There is no dashboard, sign-in or AI review yet. Current
status is in `docs/TRACKER.md`.

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

Workspace names: `@pr-buddy/review-engine`, `@pr-buddy/github-client`, `@pr-buddy/api`.

Run the API itself (needs `.env`, see `docs/GITHUB_APP.md`):

```bash
docker compose --profile app up --build api
```

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

Three workspaces with one-way dependencies:

```
apps/api ──► packages/github-client ──► packages/review-engine
```

- **`review-engine`** is pure. It takes a `ReviewContext` (pull request metadata plus changed
  files) and a config object, and returns findings. Pipeline in `src/engine/`: validate input with
  Zod → deep-freeze → run each rule isolated with a time limit → validate each finding → verify
  file and line against the diff (unverifiable locations are removed, not the finding) → dedupe
  and sort. Rules return drafts; the engine stamps `ruleId` and severity. ESLint forbids `fs`,
  network, `process`, `eval` and dynamic `import()` in `packages/review-engine/src`; do not
  suppress it.
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

These are design decisions with reasons recorded in `docs/BRAIN.md` (D-001 to D-022). Read the
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

| When you…                        | Update                                                                |
| -------------------------------- | --------------------------------------------------------------------- |
| Start or finish a task           | `docs/TRACKER.md`                                                     |
| Make a design decision           | `docs/BRAIN.md` (next `D-0xx` entry)                                  |
| Add a threat or a control        | `docs/SECURITY.md`                                                    |
| Change a contract, limit or flow | `docs/DESIGN.md`, `docs/DESIGN-GITHUB.md` or `docs/DESIGN-STORAGE.md` |
| Add or move a module             | `docs/ARCHITECTURE.md`                                                |
| Change a rule                    | `docs/RULES.md`                                                       |

`docs/CONTEXT.md` is the orientation page; `CONTRIBUTING.md` has the full coding rules.

## Git

Work on a branch and open a pull request; `main` is the default branch. CI (`.github/workflows/ci.yml`)
runs the same steps as `npm run check` on Node.js 22 and 24, audits production dependencies and
builds the API image.
