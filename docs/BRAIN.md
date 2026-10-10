# PR Buddy — Brain

The project's memory: why things are the way they are. Read this before changing a decision, and
add to it when you make one.

## 1. Principles

1. Reliable and explainable first; AI second; automation last.
2. A finding never claims more than its evidence supports.
3. Never invent a file or line. Verify it or drop it.
4. Never execute code from a reviewed repository.
5. Everything from outside is untrusted until a schema has parsed it.
6. Build what the current milestone needs. Record the rest here or in the tracker.

## 2. Decision log

Each entry: the decision, the reason, and what was rejected.

### D-001 — Build the review engine before anything else

**Decision.** Milestone 1 is the engine alone: no GitHub App, database, dashboard or AI.
**Why.** The engine is the product. It can be finished and tested with fixtures and no accounts.
**Rejected.** Starting with the dashboard or webhook plumbing.

### D-002 — Monorepo with npm workspaces

**Decision.** One repository; packages under `packages/`, applications under `apps/`.
**Why.** The API and dashboard will share the engine's types. npm workspaces need no extra tool.
**Rejected.** Turborepo, Nx and pnpm: useful later, unnecessary for one package.

### D-003 — Only create folders that have content

**Decision.** `apps/api`, `apps/web` and `packages/github-client` are not created yet.
**Why.** Empty scaffolding misleads readers about what exists.

### D-004 — Zod schemas are the source of truth for types

**Decision.** Data types are inferred with `z.infer`; they are not also written by hand.
**Why.** One definition cannot drift from itself, and the same schema validates at runtime.

### D-005 — Rules return drafts; the engine stamps identity and severity

**Decision.** A rule returns message, evidence and optional location. The engine adds `ruleId`
and resolves `severity`.
**Why.** Less repetition in rules, and a rule cannot report under another rule's ID.

### D-006 — The engine takes a configuration object, not a file

**Decision.** No YAML parsing and no file reading in the engine. The example is JSON.
**Why.** Keeps the engine free of I/O and of a YAML dependency. YAML parsing has a history of
unsafe defaults; it belongs in the integration (M2), behind this same schema.
**Rejected.** Loading `.prbuddy.yml` inside the engine.

### D-007 — Unknown rule IDs in configuration are errors

**Decision.** A setting for an unregistered rule fails engine creation.
**Why.** A typo such as `max-change-files` would otherwise leave a check silently unconfigured.

### D-008 — An unverifiable location is removed, not the finding

**Decision.** If a file or line cannot be verified against the diff, the engine removes the
location, keeps the finding and records a diagnostic.
**Why.** The finding may still be useful in a summary. A wrong inline comment is worse than none.

### D-009 — A failing rule does not fail the review

**Decision.** Rule errors and timeouts are recorded per rule; other rules still report.
**Why.** One faulty rule should not hide every other finding.

### D-010 — `missing-test-changes` reports a signal with confidence 0.6

**Decision.** The message says no test files changed and that existing tests may cover the change.
**Why.** A missing test-file change does not prove a missing test.

### D-011 — Own glob matcher instead of picomatch

**Decision.** `utils/glob.ts` implements a small glob dialect (`*`, `?`, `**`, `{a,b}`) with no
regular expressions and no recursion.
**Why.** The first implementation used `picomatch`, which compiles a glob to a backtracking
regular expression. Measured on 2026-10-10 in the development container: the pattern `*a*a*a*b`
against a file name of 800 letters "a" took 26 seconds, and `*a*a*a*a*b` against 200 letters took
31 seconds. Patterns come from configuration and paths come from pull requests, and both will be
attacker-controlled once repository configuration files are read, so one pattern and one file name
could hang the reviewer. The replacement makes at most pattern-length × path-length comparisons.
It also leaves `zod` as the only runtime dependency.
**Cost.** A smaller dialect: no character classes, negation, extglobs or escaping. `[`, `(` and
`!` are literal, which suits framework paths such as `app/(shop)/[id]/page.tsx`.
**Rejected.** Keeping picomatch and restricting which patterns are accepted: no restriction short
of the same small dialect gave a bound that could be stated with confidence.

### D-012 — Tests live in `tests/`, mirroring `src/`

**Decision.** `tests/unit/<module>/…` rather than test files next to source files.
**Why.** Tests share fixtures and builders, and the build excludes them with one line.

### D-013 — Node.js 22 or newer, ES modules only

**Decision.** `engines.node` is `>=22.12`. No CommonJS build.
**Why.** Node.js 20 reached end of life in April 2026. A single module format halves the build.

### D-014 — MIT license

**Decision.** MIT.
**Why.** Maximum adoption for a developer tool. Revisit before a hosted service launches if
protection against closed forks becomes important.

### D-015 — Develop inside Docker

**Decision.** `compose.yaml` provides a `dev` service; all npm commands run in it.
**Why.** No Node.js install on the host, the same version for everyone, and `node_modules` stays
in a Docker volume instead of the working folder.

### D-016 — File paths with backslashes or control characters are rejected

**Decision.** The context schema rejects such paths even though Git permits them.
**Why.** They are vanishingly rare in real repositories and common in attacks. The integration
decides whether to skip such a file or the whole review.

### D-017 — GitHub knowledge lives in one package, behind an interface

**Decision.** `@pr-buddy/github-client` owns signatures, event formats, API calls and Markdown.
The API depends on its `RepositoryClient` interface, never on Octokit.
**Why.** Every review flow can be tested with an in-memory fake, and a second platform later
means a second client, not a rewrite.

### D-018 — Milestone 2 has no database

**Decision.** The GitHub App is stateless. PostgreSQL is deferred to the milestone that needs
review history, which is the dashboard.
**Why.** The Milestone 2 goal is one correct review per pull request with no duplicates. That is
met without storage: the summary is one comment updated in place, the head commit is re-checked
before publishing, and reviews of one pull request run one at a time. A database would add a
service, migrations and failure modes while proving nothing more about review quality.
**Cost.** Delivery memory and queued reviews are lost on restart; see the known limits in
[SECURITY.md](SECURITY.md).
**Answers.** Open question Q2: an in-process queue is enough for now.

### D-019 — The webhook payload is only a trigger

**Decision.** The review service fetches the pull request itself and ignores the title, body and
commits in the webhook body.
**Why.** It always reviews the current state, and a stale or reordered delivery cannot make it
review old data.

### D-020 — Repository configuration is JSON, read at the base commit

**Decision.** `.github/pr-buddy.json`, fetched at the pull request's base SHA.
**Why base.** A contributor must not be able to switch off checks for their own pull request.
**Why JSON.** No YAML parser to add and audit. YAML can be added later behind the same schema.
**Why that path.** A GitHub App can be granted read access to a single named file, so PR Buddy
needs no access to repository contents.

### D-021 — One summary comment, updated in place; no comment for a clean pull request

**Decision.** PR Buddy keeps a single comment per pull request. It posts nothing when there are
no findings, unless an earlier comment needs to be corrected.
**Why.** Low noise is the product promise, and updating in place makes publishing idempotent.
**Rejected for now.** Check runs (another permission) and inline review comments (no built-in
rule produces a line yet).

### D-022 — Draft pull requests are not reviewed

**Decision.** A draft is skipped and reviewed when it is marked ready.
**Why.** A draft says the author is not asking for review yet.

### D-023 — A total patch budget per review

**Decision.** The patches of one review may total 10 million characters. The GitHub client stops
keeping patches once the budget is spent, and the engine rejects input that exceeds it.
**Why.** Each patch was limited to 1 million characters, but 3,000 files could still add up to
gigabytes held in memory. A file past the budget keeps its entry and loses only its patch, so
rules that look at file names still see it, and the summary says how many diffs were left out.
**Limit.** GitHub's response for one page of files is held in memory before it can be trimmed.

### D-024 — A hunk that does not match its header is unverifiable

**Decision.** The patch parser marks a hunk as well-formed only if it contains exactly the lines
its header declares. Lines in other hunks cannot be used to verify a finding's location. A
trailing newline is not a line.
**Why.** The earlier parser accepted an empty string as a blank context line. A hunk cut short,
followed by the empty string that a trailing newline leaves behind, could make a line look
verified when it was not in the diff. Found by an external review on 2026-10-10.

### D-025 — Rate limits are waited out, within a bound

**Decision.** A GitHub rate-limit response is retried after the time GitHub asks for
(`Retry-After`, or the reset time), if that is at most 60 seconds. Otherwise the review fails.
**Why.** The webhook has already been acknowledged, so nobody else will retry. Waiting longer than
a minute would hold a queue slot for too long.

### D-026 — A failed review releases its delivery

**Decision.** When a review fails, its delivery ID is forgotten.
**Why.** GitHub's "Redeliver" sends the same delivery ID. Without this, a review that failed on a
rate limit could not be recovered for 24 hours, because the redelivery would be dropped as a
duplicate.

### D-027 — Stale publication is narrowed, not eliminated

**Decision.** The documents say what is guaranteed: the head commit is checked immediately before
publishing, and the next review corrects the comment.
**Why.** A push can still land between that check and the comment call. GitHub offers no
compare-and-set for comments, so the window cannot be closed, only kept short. Earlier wording
("never published") claimed more than the code can promise.

### D-028 — The single-file permission stays; verified live

**Decision.** The app requests read access to one named file instead of all repository contents.
**Why.** An external review said GitHub has no such permission. It does: GitHub's REST
documentation lists `single_file` among an app's permissions and `single_file_paths` on an
installation.
**Verified on 2026-10-10.** An app registered with only metadata, pull requests and single file
`.github/pr-buddy.json` read that file at a base commit through the Contents API and applied it:
a pull request in the test repository was reviewed with the severity and disabled rule the file
set. A missing file returns 404, which is treated as "no configuration".
**Registration note.** In an app manifest the path is given as `single_file_name`.

### D-029 — PostgreSQL through `pg` and SQL files, without an ORM

**Decision.** Storage uses the `pg` driver with hand-written, parameterised SQL and plain SQL
migrations applied by a small runner. This answers open question Q1 with "neither".
**Why.** The service runs about ten statements. An ORM would add a code generator or a query
builder, a migration tool and their upgrade paths, to save very little code. Plain SQL is also
the easiest thing to audit, and the statements that matter here (`ON CONFLICT`, advisory locks)
are clearest written as SQL.
**Revisit when.** The dashboard needs many filtered, joined queries. That is the point at which a
query builder starts to pay for itself.
**Rejected.** Prisma (generator, larger image) and Drizzle (fine, but unnecessary at this size).

### D-030 — The database is optional

**Decision.** Without `DATABASE_URL` the service runs as in Milestone 2: deliveries in memory, no
history.
**Why.** Self-hosting should stay a three-variable setup for people who only want the comment.
The in-memory stores are needed for tests anyway.

### D-031 — Pull request content is not stored

**Decision.** The database holds identifiers, commit IDs, findings, counts and timings. It never
holds titles, descriptions, patches, file contents or error messages.
**Why.** Stored source is a liability: it must be protected, retained and deleted correctly.
Findings already carry what a reader needs. File paths inside findings are the one piece of
repository content that is kept, and the design documents say so.

### D-032 — History is written now and read later

**Decision.** This step records history but adds no endpoint to read it.
**Why.** Reading needs to know who is asking and which installations they may see. That belongs
with sign-in, which arrives with the dashboard. An unauthenticated read endpoint would leak file
names across tenants.

### D-033 — Storage tests use a real PostgreSQL

**Decision.** No mocked driver. Each test file gets its own schema in a real server.
**Why.** Conflict handling, transactions, cascades and locks are the behaviour under test, and a
mock would only confirm that the code sends the SQL it sends.

### D-034 — A storage failure does not fail a published review

**Decision.** If saving a review fails, the error is logged and the review still counts as done.
**Why.** By then the comment is on the pull request. Failing would release the delivery and
invite a redelivery that repeats work the user has already received.

## 3. Glossary

| Term       | Meaning                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| Context    | The validated description of one pull request given to the engine                       |
| Rule       | A deterministic check with an ID, version, default severity and options schema          |
| Draft      | What a rule returns, before the engine validates and stamps it                          |
| Finding    | A validated, stamped result reported to the caller                                      |
| Evidence   | The facts a finding is based on, as label and value pairs                               |
| Diagnostic | A note that the engine rejected or corrected something a rule returned                  |
| New side   | The lines of a file as they are after the change; the only lines a finding may point at |
| Hunk       | One contiguous block of changes in a patch, introduced by an `@@` header                |

## 4. Open questions

| #   | Question                                                                               | Needed by                    |
| --- | -------------------------------------------------------------------------------------- | ---------------------------- |
| Q1  | Prisma or Drizzle for database access?                                                 | M3, with the dashboard       |
| Q2  | Answered by D-018: an in-process queue is enough until reviews must survive a restart  | —                            |
| Q3  | Should findings also be allowed on removed lines (the old side)?                       | M2                           |
| Q4  | Which static-analysis and secret-scanning tools to integrate rather than re-implement? | M3                           |
| Q5  | Should third-party rules run in a worker thread with a hard time limit?                | When third-party rules exist |

## 5. Lessons learned

Add an entry whenever something surprising costs time.

| Date       | Lesson                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-10 | The project folder is inside OneDrive. Keep `node_modules` out of it (it lives in a Docker volume) so OneDrive does not try to sync tens of thousands of files.           |
| 2026-10-10 | A well-known library is not automatically safe on hostile input. Measure the worst case of anything that touches pull request content before depending on it (see D-011). |
| 2026-10-10 | typescript-eslint supports TypeScript below 6.1, so the project uses TypeScript 6 even though 7 is released. Check that peer range before upgrading TypeScript.           |
