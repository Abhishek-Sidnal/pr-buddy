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

### D-035 — Findings never quote source lines

**Decision.** A rule that reads added lines reports what it found and where (rule, file, line),
never the text of the line.
**Why.** Findings are stored (D-031 forbids storing file contents) and published. The line is
already visible in the diff at the location the finding points to.

### D-036 — Text matching reports less than full confidence

**Decision.** `debug-statements` reports 0.9, `credential-files` 0.8.
**Why.** A `console.log(` can sit inside a string; a `.key` file can be something harmless. The
rules match text and names, not meaning, and their confidence should say so (principle 2).

### D-037 — Credential detection is by file name only

**Decision.** `credential-files` looks at names such as `.env` and `*.pem`. It does not scan file
contents for secrets.
**Why.** Pattern-matching secrets inside code is what dedicated scanners do well and regular
expressions do badly. A file name is cheap, deterministic and rarely wrong.

### D-038 — Thresholds are applied by the engine and are visible

**Decision.** `report.minSeverity` and `report.minConfidence` live in the engine's configuration.
Hidden findings are counted, and the comment states the count.
**Why.** Every integration gets the same filtering, and a reader can tell that something was
hidden rather than wondering whether it was checked.

### D-039 — Line comments are reconciled by fingerprint

**Decision.** Each line comment carries a hidden fingerprint of its finding (rule, file, line,
message). On each review PR Buddy posts comments for new fingerprints, leaves existing ones, and
deletes its own comments whose fingerprint is gone. New comments go out as one review, so a
review sends one notification.
**Why.** Without reconciliation every push would repeat every comment.
**Cost.** When a push moves a flagged line, its comment is deleted and posted again at the new
line.

### D-040 — Line comments are best-effort; the summary is the record

**Decision.** The summary comment lists every finding. Line comments are an addition, capped at 20
per review, and a failure to post them is logged without failing the review.
**Why.** The summary is already on the pull request by then (same reasoning as D-034).

### D-041 — The AI reviewer is a separate package behind a provider interface; no provider ships yet

**Decision.** `@pr-buddy/ai-reviewer` holds the prompt, the output checks and an `AiProvider`
interface. The service is given a reviewer in `main.ts` or runs without one. No real provider is
included.
**Why.** Which company receives a user's private code, and who pays for it, is the operator's
decision and is still open. Everything that makes the feature safe is independent of that choice;
an adapter is small.
**Cost.** The feature cannot run against a real model until a provider is added, so resistance to
prompt injection is not yet measured.

### D-042 — AI review needs two switches and is off by default

**Decision.** The operator must supply a provider and the repository must set `ai.enabled`, read
at the base commit.
**Why.** It sends code to a third party. Neither the operator nor a repository owner should have
that happen without asking for it, and a contributor must not be able to switch it on.

### D-043 — Pull request content is data; model output is untrusted input

**Decision.** Content goes into the prompt as one JSON document, apart from fixed instructions.
The reply is length-checked, parsed and validated entry by entry, and each suggestion's file and
line are checked against the files that were sent. A suggestion with an unverifiable location is
dropped whole.
**Why.** No prompt reliably stops injection, so what the model returns is constrained instead.
Rules lose only the location (D-008) because their logic is trusted; a model that cites a line
that does not exist is likely wrong about the rest too.

### D-044 — The model does not set its own confidence or reach `critical`

**Decision.** Every AI suggestion has confidence 0.5 and a severity of at most `high`.
**Why.** A finding never claims more than its evidence shows (D-010, D-036). A model's self-reported
certainty is not evidence. The fixed value also gives repositories one dial:
`report.minConfidence` above 0.5 hides all suggestions.

### D-045 — AI suggestions appear in the summary only

**Decision.** They are not posted as line comments.
**Why.** Line comments are reconciled by fingerprint (D-039), which includes the message. A model
phrases the same point differently on each run, so every push would delete and repost them.
**Revisit when.** There is a fingerprint for suggestions that survives rewording.

### D-046 — The text of AI suggestions is not stored

**Decision.** `ai_reviews` keeps provider, model, status, counts, tokens and duration. Messages
are published on the pull request and nowhere else.
**Why.** A model that has read the code may quote it, and the database holds no source (D-031,
D-035).
**Cost.** The dashboard will show that suggestions were made, not what they said.

### D-047 — Send the least that a review needs

**Decision.** Title, a bounded description, and the new-side lines visible in the diff of
selected files. Credential-like files, lockfiles and removed files are never sent. A file that
does not fit the budget is left out whole.
**Why.** Less sent is less exposed and less paid for. A file cut in the middle invites
suggestions about code the model could not see.

### D-048 — AI review is best-effort: one request, no retry

**Decision.** A time-out, provider error or unusable reply is recorded and noted in the comment;
the rule findings are published regardless. The provider's error message is not logged.
**Why.** The suggestions are optional (same reasoning as D-040). A retry doubles cost. Provider
errors can echo the prompt.

### D-049 — Sign-in is GitHub's; the user token is used once and dropped

**Decision.** People sign in through the GitHub App's own authorisation flow. The token GitHub
returns reads the person's ID, login and accessible installations, and is then discarded.
**Why.** PR Buddy already is a GitHub App, so there is nothing new to register and no password to
protect. A token that is not kept cannot leak.
**Cost.** Access cannot be re-checked during a session (see D-050).

### D-050 — What a person may see is GitHub's list of their installations, taken at sign-in

**Decision.** A session stores the installation IDs GitHub returned. Every read filters by them.
Sessions last 8 hours and are not renewed.
**Why.** GitHub already knows who can access what; copying its permission model would drift.
**Cost.** A person who loses access keeps seeing that history for up to 8 hours.
**Revisit when.** Someone needs revocation sooner; then listen for installation webhooks.

### D-051 — Sessions are rows in PostgreSQL, stored as a hash of the cookie

**Decision.** The cookie holds 32 random bytes. The table holds their SHA-256.
**Why.** Server-side sessions can be ended and survive restarts; a signed cookie cannot be
revoked. Hashing means a copy of the table is not a set of working cookies. The token is random,
so a plain hash is enough: there is nothing to brute-force.

### D-052 — The API serves the dashboard from its own origin

**Decision.** `apps/web` is built to static files that the API serves next to `/api` and `/auth`.
**Why.** One origin means no CORS, a `SameSite=Lax` cookie that never crosses sites, and one
container to run.
**Cost.** The dashboard cannot be scaled or deployed apart from the API.

### D-053 — The dashboard is optional

**Decision.** It exists only when the database and the three dashboard variables are set. A
partial set stops start-up.
**Why.** The service must keep working with only the three GitHub App variables (D-030), and a
half-configured sign-in should fail loudly, not at the first visitor.

### D-054 — Hidden and missing are the same answer

**Decision.** A review or repository outside the session's installations answers `404`, exactly
like one that does not exist. The limit is part of each SQL statement, not a check afterwards.
**Why.** A `403` would confirm that an ID exists. A filter in the query cannot be forgotten by a
later caller of the same function.

### D-055 — React and Vite, with no component library

**Decision.** Runtime dependencies of the web app are React, React Router, Zod (to check every
API answer) and the two bundled IBM Plex fonts. Styles are plain CSS driven by tokens.
**Why.** Four read-only pages do not need more, and every dependency in the browser is code that
runs with the user's session.

### D-056 — The dashboard is read-only

**Decision.** It shows history. Repository settings stay in `.github/pr-buddy.json`.
**Why.** That file is reviewed like code and read at the base commit (D-020). A second place to
change settings would need its own permissions and would bypass both.

### D-057 — Visual direction: Graphite / Signal Lime

**Decision.** The maintainer chose Palette A of the UI blueprint, with IBM Plex Sans and Mono, in
a dark and a light theme. Recorded in [ADR 0001](ADR/0001-visual-direction.md); the rules are in
[DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).
**Why.** Distinctive in a screenshot, high-contrast and quiet. Colours are semantic tokens in one
file, so the palette can change without touching components.

### D-058 — The dashboard shows only what the service can back

**Decision.** Blueprint items without data behind them are left out, not mocked: the pull request
queue, titles and authors, diffs, the text of AI suggestions, "re-run review", and editable rules
or settings. The gaps are listed in DESIGN-SYSTEM.md, section 6.
**Why.** A control that does nothing, or sample data in a production screen, misleads. Most of
these are absent because of earlier decisions about what is stored (D-031, D-046, D-056).

### D-059 — A review is marked out of date from stored history, not from GitHub

**Decision.** A review page shows a notice when a later completed review of the same pull request
exists at another commit, and links to it.
**Why.** The dashboard holds no GitHub token (D-049), so it cannot ask what the head commit is
now. The stored history answers the question that matters: has this been superseded?
**Cost.** A push that was never reviewed, for example to a draft, is not noticed.

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
| Q1  | Answered by D-029: neither; SQL is hand-written                                        | —                            |
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
