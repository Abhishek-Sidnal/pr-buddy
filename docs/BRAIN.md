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
**Amended by D-075:** the dashboard can now change one thing, an installation's AI key, which
cannot live in a repository file because it is a secret.

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

### D-060 — Providers are small adapters over `fetch`; no vendor SDK

**Decision.** Bedrock, Anthropic, OpenAI, Azure AI Foundry and a generic OpenAI-compatible
provider are each one file that builds a request and reads a reply. Bedrock requests are signed
with an own implementation of AWS Signature Version 4, checked against AWS's published values.
**Why.** Four SDKs would be hundreds of packages in the image for one HTTP call each, and every
dependency is supply-chain exposure (D-011 is the precedent). One request shape per service is
easy to read and to test against a stand-in.
**Cost.** AWS credentials come from the environment only: instance roles, profiles and single
sign-on are not looked up. Features an SDK adds for free, such as retries, are absent on purpose
(D-048).
**Revisit when.** Someone needs role-based AWS credentials.

### D-061 — The operator must name the model; there is no default

**Decision.** `AI_MODEL` is required with every provider.
**Why.** The model decides the cost of every review and which terms apply to the code sent. A
default would make that choice silently and would go stale.

### D-062 — A provider's error is reduced to its HTTP status

**Decision.** A reply that is not `2xx` becomes an error named `ProviderHttp<status>`; its body
is not read into the error.
**Why.** Error bodies from model services can repeat the request. The status is what an operator
needs to tell a bad key (401, 403) from a missing model (404) or a rate limit (429).

### D-063 — The example deployment is Docker Compose with Caddy in front

**Decision.** `deploy/` holds a Compose file with three services: Caddy, the API and PostgreSQL.
Caddy terminates TLS and gets its certificate by itself.
**Why.** It is the smallest stack that is honestly production-shaped: one command, automatic
certificates, nothing but the proxy exposed. The same file serves `localhost` with a local
certificate, so the guide can be tried before a domain exists.
**Cost.** One machine, no redundancy. Anything larger is the operator's design.

### D-064 — Unsafe combinations of valid settings are warnings, not errors

**Decision.** At start-up the service logs a warning when settings are each valid but risky
together, for example an HTTPS public address with `TRUST_PROXY=0`. It still starts.
**Why.** The service cannot see the network in front of it, so it cannot be sure. A wrong guess
that refused to start would be worse than a clear warning.

### D-065 — The service sends `Strict-Transport-Security` itself

**Decision.** When `PUBLIC_URL` is HTTPS, dashboard responses carry HSTS for one year.
**Why.** It must not depend on the operator remembering to configure it in the proxy. It is not
sent for `http://localhost`, where it would be wrong.

### D-066 — Requested reviews are remembered in the database until they finish

**Decision.** A webhook that asks for a review writes a row to `pending_reviews` before it is
acknowledged. The row is deleted when the review finishes. At start-up the service queues every
row that is left. The in-process queue (D-018) still decides what runs when.
**Why.** A webhook is acknowledged before its review runs. A restart in between used to lose the
review silently, and GitHub does not redeliver what was acknowledged.
**Cost.** At-least-once, not exactly-once: a review interrupted after it published runs again,
which is harmless because publishing is idempotent. Two instances would each recover the same
rows; that too only repeats work.
**Revisit when.** Several instances must share work; then the table becomes the queue itself.

### D-067 — Recovery is bounded

**Decision.** A pending review is retried at most three times and only within 24 hours of the
request. Beyond that it is dropped.
**Why.** A review that fails every time, for example because the app was uninstalled, must not
be retried at every start for ever. After a day the pull request has usually moved on, and its
next push asks for a review anyway.

### D-068 — Reviews are kept for 365 days unless the operator says otherwise

**Decision.** `REVIEW_RETENTION_DAYS` defaults to 365. Older reviews are deleted, with their
findings, once a day and at start-up, in batches. `0` keeps everything.
**Why.** Stored findings include file paths. Keeping them for ever is a growing liability and a
growing table, and no feature needs history that old.
**Cost.** A deployment upgraded to this version loses reviews older than a year at its next
start, unless it sets the variable first. The release notes must say so.

### D-069 — Uninstalling the app deletes that installation's history

**Decision.** On `installation.deleted` the service deletes the installation's repositories,
reviews, findings, pending reviews and sessions. On `suspend`, and when a repository is removed
from an installation, it ends the sessions that could see the data; a removed repository's
history is deleted.
**Why.** Once the app is uninstalled nobody can sign in to see that data, so keeping it serves
no one and exposes it to any later breach. Ending sessions closes the eight-hour window of D-050
for the cases GitHub tells the service about.
**Cost.** Reinstalling starts with an empty history. A person removed from an organisation is
not an installation event, so that case still waits for the session to end.

### D-070 — Actions are pinned to commits and images to digests

**Decision.** Every GitHub Action is referenced by a full commit SHA and every container image
by its `sha256` digest. A script in CI fails the build on a reference by tag alone. Dependabot
proposes the updates.
**Why.** A tag can be moved to other content after it was reviewed, and a compromised action
runs with the repository checked out. A commit or a digest cannot change.
**Cost.** Pins go stale unless the Dependabot pull requests are merged, and a digest says
nothing a person can read; the tag stays beside it for that.

### D-071 — An AI key belongs to an installation

**Decision.** One provider, model and key per installation, used for all its repositories.
**Why.** A review starts from a webhook, when nobody is signed in, so the key cannot depend on a
person. The installation is the unit GitHub gives the service, and the unit that pays.
**Cost.** No key per repository or per team.

### D-072 — Only an owner may change an installation's key

**Decision.** On a personal account, that person; on an organisation, a member whose role is
`admin`. The role is read from GitHub at sign-in and kept in the session. Anything short of a
clear yes from GitHub means no.
**Why.** Reading history is safe for anyone GitHub lists (D-050). Deciding where a whole
organisation's code is sent is not.
**Cost.** A demoted owner keeps the ability until their session ends, at most eight hours.

### D-073 — Keys are encrypted with AES-256-GCM under a master key outside the database

**Decision.** `SECRETS_ENCRYPTION_KEY` holds 32 random bytes. Each save uses a new nonce, and the
installation ID and provider are authenticated with the ciphertext. Each row records which master
key encrypted it, and a previous key can still decrypt, so the master key can be rotated.
Encryption sits behind a `SecretCipher` interface.
**Why.** A copy of the database must not be a list of working keys. Binding a ciphertext to its
row stops it being moved to another installation. The interface lets a key service replace the
variable later.
**Cost.** The running service can decrypt, so taking it over yields the keys. That is inherent
in calling a provider on a customer's behalf.

### D-074 — Customers choose among fixed providers and cannot enter an address

**Decision.** Anthropic, OpenAI and Bedrock, each with its host fixed in code. Providers that
need a base URL stay with the operator.
**Why.** An address typed by a customer would let them make the service send requests, with
their content, to hosts on its own network.

### D-075 — The dashboard may change one thing, behind three locks

**Decision.** The key routes are the first that change state. They require the session cookie,
an `Origin` equal to the dashboard's, and the header `X-PR-Buddy-Request`. This amends D-056.
**Why.** A secret cannot live in a repository file. `SameSite=Lax` already keeps the cookie off
cross-site writes; the header forces a browser to ask permission first, which the service never
grants; the origin check covers a browser that gets either wrong.

### D-076 — A key is checked with the provider before it is stored

**Decision.** Saving sends one minimal request with the new key. A refusal is reported and
nothing is stored.
**Why.** Otherwise a typing mistake shows up at the next pull request, as a failed AI review
that the person who made it never sees.
**Cost.** One tiny request billed to the customer per save. A provider outage blocks saving.

### D-077 — The feature needs the master key, and is absent without it

**Decision.** No `SECRETS_ENCRYPTION_KEY`, no routes and no settings section.
**Why.** Storing keys unencrypted "for now" is how they end up unencrypted for good (D-053 is
the precedent for all-or-nothing features).

### D-078 — An installation's key wins, and never falls back

**Decision.** If an installation has a key, its reviews use it and nothing else. If that key
fails, the AI review fails; the operator's provider is not tried.
**Why.** Falling back would send a customer's code to a company they did not choose, silently.

### D-079 — Changes to a key are written to an audit table

**Decision.** `audit_events` records the installation, the GitHub user ID, the action and the
time for every save and removal. Never the key, its hint, or the model.
**Why.** "Who changed where our code goes, and when?" must have an answer.

### D-080 — A customer names an Azure resource; the service builds the address

**Decision.** Azure AI Foundry and Azure OpenAI are offered to customers. They enter the name
of their resource, checked against a pattern that allows only lower-case letters, digits and
hyphens, and the service builds `https://<resource>.openai.azure.com/openai/v1`. This extends
D-074 without changing it: a customer still never enters an address.
**Why.** Many organisations may only buy models through Azure. The risk in D-074 was a host of
the customer's choosing; a name that can only become a label under a domain Microsoft controls
is not that.
**Cost.** Azure's government and China clouds, and custom domains, are not reachable this way.
**Rejected.** A list of allowed address patterns: such lists are bypassed with redirects, odd
encodings and DNS tricks.

### D-081 — An owner can test the stored key

**Decision.** `POST /api/installations/:id/ai-key/test` sends the same minimal request as a
save, with the stored key, and reports `working`, `refused` with the status, `unreachable`,
`unreadable` or `missing`. Owners only, behind the same three locks as a write; no audit row.
**Why.** A key checked at save can expire or be revoked later, and until now the only sign was
a failed AI review on someone's pull request.
**Cost.** One tiny request billed to the customer per test.

### D-082 — CI publishes the API image; a server may pull it and need not build

**Decision.** A separate workflow builds the API image and pushes it to GitHub's container
registry: `edge` for every commit on `main`, and the version plus `latest` for a release tag.
`deploy/compose.image.yaml` makes the example stack use a published image, named by the
operator in `PR_BUDDY_IMAGE`. Building on the server stays possible and stays the default.
**Why.** Building needs about 2 GB of memory; running needs far less. Pulling lets the stack
run on a 1 GB machine, makes upgrades quick, and means every server runs the bytes CI built.
**How it stays safe.** The check workflow keeps its read-only token; only the publishing job
may write packages, and it runs for `main` and version tags only, never for a pull request.
The guide tells operators to name the image by digest, which cannot be moved.
**Cost.** `edge` is published when a commit lands, not when its checks pass, so it is for
trying things and not for production. The image is built for x86-64 only. While the repository
is private, a server needs a token that may read packages.
**Rejected.** A default image in the Compose file: it would be a tag, which D-070 forbids, or a
digest that is wrong after every release.

### D-083 — The Install link exists only when the operator names the app

**Decision.** An optional setting, `GITHUB_APP_SLUG`, and a route without a session,
`GET /auth/service`, that returns it. The browser builds the install address from it after
checking it against a pattern. Without the setting there is no Install button.
**Why.** A new user needs one obvious first action, and the service cannot guess its app's
public name from the app ID.
**Rejected.** Asking GitHub for the name at start-up: one more thing that can fail before the
service is up, to save the operator one line. Putting the address in the page's HTML: the
policy forbids inline scripts, and one built page must serve every deployment.

### D-084 — After installing, GitHub sends people to the ordinary sign-in

**Decision.** The app's Setup URL is `<PUBLIC_URL>/auth/login`. No route of its own, and
nothing GitHub appends to that address is read.
**Why.** Access is whatever GitHub reports at sign-in (D-050). An installation ID taken from an
address would be a claim by whoever built the link.
**Cost.** One more redirect, and a person already signed in gets a fresh session.

### D-085 — "Getting started" shows facts, not ticks

**Decision.** The steps on the overview are derived from stored state: installations in the
session, whether a review exists, whether an installation has a key. They disappear when the
first review exists. Nothing records that a person dismissed or completed a step.
**Why.** D-058: the dashboard shows only what the service can back. A checklist a person ticks
by hand can say "done" when nothing works.

### D-086 — Backups leave the server, and the master key is not in them

**Decision.** A nightly `pg_dump` is checked and copied to a bucket outside the server.
`deploy/.env`, which holds the master key and the GitHub App's private key, is never part of it.
**Why.** A backup on the disk it protects is lost with that disk. Keeping the master key out
means a stolen backup holds customers' AI keys only as ciphertext.
**Cost.** The operator must keep `deploy/.env` somewhere else, by hand. Without it a restore
brings back the history and no stored AI key.

### D-087 — Backups and alerts are shell scripts that sign requests with `curl`

**Decision.** `deploy/backup.sh` and `deploy/watch.sh`, run by cron, using `curl --aws-sigv4`.
The server's credential may only write objects to one bucket and publish to one topic.
**Why.** They must work when the API does not, so they are not part of it. `curl` is already on
the server; a cloud vendor's tool would be one more thing to install, update and trust.
**Rejected.** A backup container in the Compose stack: it would need the Docker socket or the
database password, and a schedule of its own.

### D-088 — The watcher alerts when the set of problems changes

**Decision.** `watch.sh` remembers which checks failed last time and sends one message when
that set changes, including when it becomes empty.
**Why.** A message every five minutes during an outage is switched off within the hour, and
then the next outage is silent.
**Cost.** A problem that stays is reported once. The watcher cannot report a server that is
down; that needs an alarm outside it.

### D-089 — The queue is shared fairly between installations

**Decision.** Each job carries its installation. A free slot goes to the installation with the
fewest running reviews, then the one served longest ago, then the oldest job. One installation
may have a limited number of reviews waiting.
**Why.** On a shared service one busy customer must slow down only themselves.
**Rejected.** A queue per installation with its own concurrency: more reviews in total than the
machine was sized for. Rate limiting webhooks per installation: it drops work that there may be
room for.

### D-090 — The operator says who they are; the service does not guess

**Decision.** `OPERATOR_NAME`, `OPERATOR_CONTACT`, `OPERATOR_PRIVACY_URL` and
`OPERATOR_TERMS_URL`, all optional, shown on a public page. Unset, the page says the operator
has not published them, and the service warns at start-up.
**Why.** People should know who holds their data before they install anything. Saying "not
published" is true; hiding the section would look like an answer.

### D-091 — The privacy page describes the software and links to the operator's own texts

**Decision.** `/privacy` states what the code does with data, in fixed text kept with the code,
and separately what the operator configured. It does not contain terms of service or a legal
policy; it links to the operator's.
**Why.** The software can vouch for its own behaviour on every deployment. It cannot know an
operator's jurisdiction, company or promises, and inventing them would be worse than silence.

### D-092 — The operator gets a page of counts, kept apart from every other read

**Decision.** `GET /api/operator/overview` and a page at `/operator` show totals, review and
AI outcomes over time, the queue, and one row per installation: account, counts, last review,
AI provider. No repository name, pull request, finding, file path or login.
**Why.** An operator must see use and failures without a database client. A browser session
can be stolen, so it carries only what is needed for that.
**How it stays safe.** D-054 limits every dashboard query to the session's installations.
These queries cross installations on purpose, so they are in their own store, behind their own
router, and nothing else may call them.

### D-093 — An operator is a GitHub user ID in a setting

**Decision.** `OPERATOR_GITHUB_USER_IDS`. Everyone else gets `404` from the operator route, as
for a path that does not exist. Without the setting the route is not registered.
**Why.** There are no user accounts or roles to extend (D-049). An ID cannot be re-registered
by someone else; a login can.
**Cost.** Changing who is an operator needs a restart.

### D-094 — A command registers a GitHub App from a manifest

**Decision.** `register-app` serves one local page, sends GitHub a manifest, exchanges the
one-time code for the app's credentials and writes them to the environment file. It keeps the
previous file and never prints a secret.
**Why.** A developer needs an app of their own, because an app's webhooks go to one address
and production has it. By hand that is a dozen fields and five secrets to copy, and the
permissions are easy to get wrong.
**Rejected.** A page in the dashboard that registers the app: the service would then have to
rewrite its own configuration while running.

### D-095 — The app asks for Members: read, to learn one thing

**Decision.** The GitHub App requests the organisation permission "Members: read". It is used
for one request, `GET /user/memberships/orgs/{org}`, about the person who is signing in. A
failed owner check is logged with its reason; the reason is never stored.
**Why.** The first organisation to install the app showed that GitHub answers that request
`403` without the permission. The check failed closed, as designed, so nobody in an
organisation could set its AI key, and the cause was invisible because every failure looked
the same.
**Cost.** The app may read an organisation's member list, which it has no other use for, and
each organisation must approve the permission once. Until it does, nobody there is an owner.
**Rejected.** Treating an admin of every covered repository as an owner: it needs no
permission, but such a person is not the one who may decide for the whole organisation, and
the set of repositories can grow after the key was set.
**Lesson.** A check that fails closed still has to say why. "Unverified" in the tracker was
right, and one sign-in by a real organisation owner would have found this before release.

### D-096 — Deep review runs in the repository's CI, not on the service

**Status: accepted on 2026-10-11. Not built.**
**Decision.** A second way to run PR Buddy: a GitHub Action that reviews with the whole checkout
in view. The hosted service keeps reviewing from the diff.
**Why.** A reviewer that sees only the diff misses broken callers and existing helpers. Bringing
the code to the service would make the operator hold customers' source and run a sandbox.
Bringing the reviewer to the code needs neither: the runner is GitHub's, and so is its isolation.
**Cost.** Two ways to run one product, and a repository has to add a workflow file.

### D-097 — The tool loop is PR Buddy's own, over each provider's API

**Status: accepted on 2026-10-11. Not built.**
**Decision.** The runner implements three read-only tools and the loop that offers them to a
model, using each provider's own tool-calling API. No vendor agent toolkit.
**Why.** D-060 again: one small file per provider, and every provider PR Buddy supports can be
used in runner mode. A toolkit would tie deep review to one vendor's models and bring its own
tools, some of which run commands.
**Cost.** More code to write and test than adopting a toolkit.

### D-098 — The model searches with plain strings and reads within the checkout only

**Status: accepted on 2026-10-11. Not built.**
**Decision.** `read_file`, `search` and `list_files`. Paths are resolved and confined to the
checkout, credential files are refused, `search` takes a literal string, and every call is
bounded in size and counted.
**Why.** The author of a pull request controls what the model is tempted to read. A regular
expression from the model is a way to hang the run (D-011); a path is a way out of the folder.

### D-099 — A finding must point at code that was actually read

**Status: accepted on 2026-10-11. Not built.**
**Decision.** The runner records every file and line range a reviewer read. A finding whose
location was never read in that run is dropped.
**Why.** It turns "the model says it checked" into something code can verify, and removes the
most common kind of confident invention: a claim about a file nobody opened.

### D-100 — Runner mode comments; it does not approve or request changes

**Status: accepted on 2026-10-11. Not built.**
**Decision.** The Action posts comments only. It never submits an approving or blocking review.
**Why.** That is what PR Buddy is (PRD, section 1). A deeper review makes its findings more
useful; it does not make an unverifiable model fit to gate a merge.

### D-101 — AI findings may be line comments in runner mode, on conditions

**Status: accepted on 2026-10-11. Not built. It narrows D-045 for runner mode only.**
**Decision.** Off by default. When a repository turns it on, an AI finding becomes a line
comment only if it passed every check of the filter, including read evidence and, in the larger
shape, the lead. Their number is capped, and each is labelled as AI.
**Why.** D-045 kept AI out of line comments because a suggestion pinned to a line reads as fact
while nothing had checked it. Here something has. In hosted mode nothing changes.

### D-102 — Runner comments are posted with the workflow's token

**Status: accepted on 2026-10-11. Not built.**
**Decision.** Comments appear as GitHub Actions. The Action updates and deletes only comments
that carry PR Buddy's marker and were written by that same identity.
**Why.** It needs no service and no extra credential, so runner mode works for someone who has
never heard of a hosted PR Buddy.
**Cost.** The comments do not carry PR Buddy's name and avatar. A PR Buddy identity for runner mode
is not part of this work.

### D-103 — A runner proves which repository it is with GitHub's identity token

**Status: accepted on 2026-10-11. Not built.**
**Decision.** To report to a PR Buddy service, a run obtains GitHub's signed identity token for
that service. The service verifies the signature and takes the repository and the run from the
token's claims.
**Why.** No secret has to be created, stored in each repository, or rotated, and a run cannot
claim to be another repository.

### D-104 — In runner mode the AI key is a secret of the repository

**Status: accepted on 2026-10-11. Not built.**
**Decision.** The Action takes the key as an input, from a repository or organisation secret.
The service never sends a stored key to a runner.
**Why.** D-073 holds: no route returns a key. And the secret store of the place where the code
runs is where its owner expects to manage it.
**Cost.** An installation that uses both modes enters its key in two places.

### D-105 — One reviewer per repository, enforced on both sides, and failing closed

**Status: accepted on 2026-10-11. Not built.**
**Decision.** The mode is one value, `review.mode`, read at the base commit and validated. The
hosted service skips a repository that says `runner` and records why. The Action reviews only
on an explicit, valid `runner`, and when it cannot establish the mode it runs no rules, asks no
model and publishes nothing. An invalid file means hosted, never both and never runner. Neither
side needs the other to be reachable.
**Why.** Two reviewers on one pull request is noise and double cost. A check on one side only
would fail open whenever that side was the one that was wrong.
**Cost.** A repository whose configuration is broken cannot use runner mode until it is fixed.

### D-106 — The standalone Action proves itself before anything is built around it

**Status: accepted on 2026-10-11.**
**Decision.** Phases, each behind a gate that includes a real repository. Reporting to a
service and usage views in the dashboard are not started until the Action alone, through
phase 3, has shown useful results. Notifications and outcome measures come after that.
**Why.** A dashboard for findings nobody trusts is wasted work, and every earlier milestone
that skipped a live check found its bug in production.

### D-107 — "Generally available" is claimed only after the release checks were made

**Status: accepted on 2026-10-11.**
**Decision.** Before the Action is described as ready for others, the license, the way to
report a vulnerability, the disclosure process and the installation instructions are checked,
and the result is written down. DESIGN-RUNNER.md, section 19, holds what was found.
**Why.** The first look found that the documented way to report a vulnerability does not work,
because the repository has private reporting turned off.

### D-108 — Suggested code changes are not part of runner mode yet

**Status: accepted on 2026-10-11.**
**Decision.** The runner publishes findings in words. It does not publish a change that can be
committed with one click.
**Why.** A suggestion is code written by a model and applied by a person in a hurry. It needs
its own design: formatting, checking it against the diff, and publishing it exactly once.

### D-109 — A gate on cost never stops the rules

**Status: accepted on 2026-10-11, while building phase 1.**
**Decision.** Closed, draft and "this commit was already reviewed" end a run. "Too large" and
"a small re-push" end only the request to a model. The deterministic rules run on every open,
ready pull request at a new commit.
**Why.** The first design let a small re-push end the whole run. The rules cost nothing, and a
push of ten lines is exactly the one that removes a committed credential: the comment would
have kept accusing a pull request that had been fixed.
**Cost.** A rules-only run on every push. In phase 1 the re-push gate is measured and reported
and changes nothing, since no model is asked yet.

### D-110 — One function reads the configuration for both modes

**Status: accepted on 2026-10-11, while building phase 1.**
**Decision.** `parseRepositoryConfiguration`, in `packages/ai-reviewer`, turns the file at the
base commit into rules, the AI setting and the mode. The service and the Action both call it.
A file wrong in any part yields the defaults: hosted mode, no AI.
**Why.** D-105 depends on the two sides agreeing. Two implementations of "is this file valid"
would drift, and the first difference would be a pull request with two reviewers or none.
**Cost.** The function lives in the AI package, the only one that already knew both the engine
and the `ai` section. Its name is not the obvious place to look for the review mode.

### D-111 — Phase 2 started before two items of phase 1's gate were seen

**Status: the maintainer's instruction on 2026-10-11.**
**Decision.** Phase 2 began with a fork's pull request and GitHub's rendering of the job summary
still unverified. Both stay listed as not verified; neither is reported as passed.
**Why.** Both need the maintainer's hands: a second account, and a look at a page GitHub's API
does not return. Neither can be changed by phase 2, and the first two changes of phase 2 alter
nothing a run does.
**Cost.** A defect in either would be found later than the phases intended. Both must be seen
before the Action is called generally available (D-107).

### D-112 — The workflow checks out the head commit, and the runner verifies it

**Status: accepted on 2026-10-11, while building phase 2.**
**Decision.** The Action runs no `git`. The workflow checks out the pull request's head commit
without stored credentials. The runner reads `.git/HEAD` as a file and asks a model only if it
names the head commit GitHub's API reports. Otherwise the rules run alone and the summary says
why.
**Why.** GitHub's default checkout for a pull request is a merge commit, whose line numbers can
differ from the head's. A model reading it would cite lines that do not match the diff, and the
filter could not tell. Running `git` inside the Action would add a program that reads
configuration from the untrusted checkout.
**Cost.** Two lines the workflow's author must get right. Getting them wrong costs the AI
review, never correctness, and the job summary names the cause.

### D-113 — The tools never follow a symbolic link

**Status: accepted on 2026-10-11, while building phase 2.**
**Decision.** A path whose real location differs from the path itself is refused, whether the
link points outside the checkout or inside it. Folder walks pass over links without opening
them.
**Why.** A link is the one way a file in the checkout can stand for a file outside it: the
process's environment, which holds the AI key, or the runner's own files. Allowing links that
stay inside would need the protected-name policy applied to the target as well, and a second
path for every file in the read record. One rule with no exceptions is easier to test and to
believe.
**Cost.** A repository that keeps real source behind links has those files unread by the model.
The rules, which work from GitHub's diff, are unaffected.

### D-114 — The tools belong to the runner; the hosted service has none

**Status: accepted on 2026-10-11, while building phase 2.**
**Decision.** `packages/ai-reviewer` defines the shape of a tool (`AiTool`) and nothing that
touches a file system. The three tools live in `apps/runner`. The hosted reviewer keeps its one
request with no tools.
**Why.** The service has no checkout and must never grow one (D-096). Code that reads files, if
it sat in a shared package, would be one import away from the service.
**Cost.** The tool loop of change 2b lives in the AI package while its tools live elsewhere, so
the loop is tested with tools made for the test.

### D-115 — One policy says what never reaches a model

**Status: accepted on 2026-10-11, while building phase 2.**
**Decision.** `isNeverSentPath`, in `packages/ai-reviewer`, is used by the hosted reviewer when
it chooses files for a prompt and by the runner's tools before they open one. The tools add what
only a checkout has: everything under `.git`.
**Why.** Section 8 of the design asks for one policy in one place. Two lists would drift, and the
weaker one would be the leak.
**Cost.** Lockfiles are refused to the tools as well, though they hold no secret: the policy is
"never sent", not "secret", and a lockfile is as useless to a model in a checkout as in a diff.

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

| #   | Question                                                                                         | Needed by                    |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------- |
| Q1  | Answered by D-029: neither; SQL is hand-written                                                  | —                            |
| Q2  | Answered by D-018 and D-066: an in-process queue, with requests stored so they survive a restart | —                            |
| Q3  | Should findings also be allowed on removed lines (the old side)?                                 | M2                           |
| Q4  | Which static-analysis and secret-scanning tools to integrate rather than re-implement?           | M3                           |
| Q5  | Should third-party rules run in a worker thread with a hard time limit?                          | When third-party rules exist |

## 5. Lessons learned

Add an entry whenever something surprising costs time.

| Date       | Lesson                                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-10 | The project folder is inside OneDrive. Keep `node_modules` out of it (it lives in a Docker volume) so OneDrive does not try to sync tens of thousands of files.                                                                     |
| 2026-10-10 | A well-known library is not automatically safe on hostile input. Measure the worst case of anything that touches pull request content before depending on it (see D-011).                                                           |
| 2026-10-10 | typescript-eslint supports TypeScript below 6.1, so the project uses TypeScript 6 even though 7 is released. Check that peer range before upgrading TypeScript.                                                                     |
| 2026-10-10 | Two Compose files with the same project name share containers and volumes. The example production stack took over the development database's container until it was given a name of its own. Name every Compose project explicitly. |
| 2026-10-10 | `docker compose up` does not rebuild an image. A restart after a merge ran the old code until `--build` was passed.                                                                                                                 |
