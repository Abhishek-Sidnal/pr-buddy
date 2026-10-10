# PR Buddy — Security Design

How PR Buddy is built to be safe. To report a vulnerability, see the policy in
[../SECURITY.md](../SECURITY.md).

## 1. What PR Buddy must protect

| Asset                                                         | Why it matters                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| Source code under review                                      | It is often private and proprietary                            |
| Credentials: GitHub App key, webhook secret, AI provider keys | They grant access to repositories and paid services            |
| Integrity of review output                                    | A reviewer that can be tricked into silence is worse than none |
| Availability of the review service                            | A stuck reviewer blocks the team's workflow                    |

## 2. Trust boundaries

Everything in a pull request is written by someone PR Buddy does not trust: the title,
description, file names, file contents, commit messages and any configuration file inside the
repository. A contributor to an open-source project can be anyone.

```
untrusted                        │  trusted
─────────────────────────────────┼─────────────────────────────
PR title, body, paths, patches   │  engine code
repository configuration file    │  built-in rule code
webhook request body (M2)        │  operator-supplied secrets
AI model output (M3)             │  operator-supplied configuration
```

Data crosses from left to right only through a validating schema.

## 3. Threats and controls in Milestone 1

| #   | Threat                                                 | Control                                                                                                                                                                                    | Where                              |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| T1  | PR content is executed by the reviewer                 | The engine has no `eval`, `new Function`, `vm`, `child_process` or dynamic import; ESLint blocks them                                                                                      | `eslint.config.js`                 |
| T2  | Engine reads or writes files, or opens connections     | File, network and process modules are blocked by ESLint in engine source                                                                                                                   | `eslint.config.js`                 |
| T3  | Path traversal through file names (`../../etc/passwd`) | Paths must be relative with no `.`/`..` segments, backslashes or control characters                                                                                                        | `context/repo-path.ts`             |
| T4  | Oversized input exhausts memory or CPU                 | Hard limits on file count, path, patch, body and pattern sizes                                                                                                                             | `limits.ts`                        |
| T5  | Regular-expression denial of service                   | Regular expressions are anchored and use bounded quantifiers; text scanning uses `indexOf` loops; glob matching uses no regular expressions and is bounded by pattern length × path length | `diff/`, `utils/`                  |
| T6  | Unexpected fields smuggle data or behaviour            | Strict schemas reject unknown fields                                                                                                                                                       | `context/`, `config/`, `findings/` |
| T7  | Prototype pollution through `__proto__` keys           | Parsed data is copied by the schema; lookups use `Map` and `Object.hasOwn`                                                                                                                 | `config/resolve-config.ts`         |
| T8  | A rule impersonates another rule                       | The engine stamps the rule ID on every finding                                                                                                                                             | `engine/run-rule.ts`               |
| T9  | A rule modifies input seen by other rules              | Context and options are deep-frozen                                                                                                                                                        | `utils/deep-freeze.ts`             |
| T10 | A rule hangs or crashes the review                     | Per-rule time limit and error isolation                                                                                                                                                    | `engine/run-rule.ts`               |
| T11 | A rule floods the review with findings                 | Per-rule finding cap                                                                                                                                                                       | `engine/run-rule.ts`               |
| T12 | A finding points at an invented location               | File and line are verified against the diff or removed                                                                                                                                     | `findings/finding-location.ts`     |
| T13 | Error messages leak input                              | Errors name the field and constraint only                                                                                                                                                  | `errors.ts`, `utils/zod-issues.ts` |
| T14 | A typo in configuration silently disables a check      | Unknown rule IDs and unknown fields are errors                                                                                                                                             | `config/resolve-config.ts`         |

### Known limit of T10

A time limit stops waiting for an asynchronous rule. It cannot interrupt synchronous code that
never yields, because JavaScript runs one task at a time. Built-in rules are bounded by the input
limits. Third-party rules are trusted code chosen by the operator; running them in a worker thread
with a hard kill is a later option.

## 4. Supply chain

| Control                      | Detail                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Few runtime dependencies     | Server: Express, a rate limiter, `pg`, `pino`, Octokit and Zod. Browser: React, React Router, Zod, two font files. No AI vendor SDK (D-060) |
| Lockfile                     | `package-lock.json` is committed; CI installs with `npm ci` and verifies registry signatures                                                |
| Pinned actions               | Every GitHub Action is referenced by a full commit SHA, with its version in a comment (D-070)                                               |
| Pinned images                | Every base image, in Dockerfiles, Compose files and the CI service, is referenced by its `sha256` digest (D-070)                            |
| Pins are enforced            | `scripts/check-pins.sh` runs in CI and fails on any action or image referenced by a tag alone                                               |
| Automated updates            | Dependabot for npm, GitHub Actions, Dockerfiles and Compose files, so pins move by reviewed pull request                                    |
| Audit                        | CI runs `npm audit` on production dependencies                                                                                              |
| CI permissions               | The workflow token is read-only and no secret is available to it                                                                            |
| No secrets in the repository | `.gitignore` excludes `.env` files and private keys                                                                                         |

Known limits: the digest of the PostgreSQL image used as a CI service is not updated by
Dependabot and must be moved by hand; npm dependencies are locked by version and integrity hash,
which is what the lockfile provides, not vendored.

## 5. Development practices

- Review every dependency before adding it; prefer none.
- Never commit credentials, tokens or real customer code. Fixtures are invented.
- Never log pull request contents at info level; patches can contain secrets.
- Treat a security-relevant ESLint suppression as a change that needs review.

## 6. Threats and controls in Milestone 2 — GitHub App

| #   | Threat                                                                   | Control                                                                                                                                                                                      | Where                                                                                           |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| G1  | Forged webhook                                                           | `X-Hub-Signature-256` is verified as HMAC-SHA256 over the raw body with a constant-time comparison, before the body is parsed; failures get `401`                                            | `github-client/webhook/verify-signature.ts`                                                     |
| G2  | Replayed or repeated delivery                                            | Delivery IDs are remembered for 24 hours; a repeat is acknowledged and not processed                                                                                                         | `api/modules/github/delivery-store.ts`                                                          |
| G3  | Webhook body used as a source of truth                                   | The payload only triggers a review; the pull request is fetched from the API                                                                                                                 | `api/modules/reviews/review.service.ts`                                                         |
| G4  | Oversized or flooding requests                                           | 1 MB body limit, per-address rate limit, bounded queue with `503` beyond it                                                                                                                  | `api/app.ts`, `api/modules/reviews/review-queue.ts`                                             |
| G5  | Excess privilege                                                         | Three permissions only: metadata, pull requests, and one named file                                                                                                                          | [DESIGN-GITHUB.md](DESIGN-GITHUB.md) section 8                                                  |
| G6  | Long-lived credentials                                                   | Short-lived installation tokens issued per installation; no personal tokens                                                                                                                  | `github-client/api/octokit-client.ts`                                                           |
| G7  | A contributor weakens checks on their own pull request                   | Configuration is read at the base commit, never from the pull request's commits                                                                                                              | `api/modules/reviews/review.service.ts`                                                         |
| G8  | A review of an old commit overwrites a newer one                         | One review at a time per pull request; the head commit is compared again immediately before publishing. This narrows the window but cannot close it; see "Stale results" in DESIGN-GITHUB.md | `review-queue.ts`, `review.service.ts`                                                          |
| G9  | Contributor-chosen text injects mentions, links or HTML into the comment | Evidence is rendered as code; messages are escaped; `@` is neutralised                                                                                                                       | `github-client/output/render-summary.ts`                                                        |
| G10 | Someone copies the comment marker to hijack or block updates             | Only a comment written by this app is treated as PR Buddy's                                                                                                                                  | `github-client/output/publish-summary.ts`                                                       |
| G11 | Contributor code is executed                                             | Nothing is checked out, installed or run; only API data is read                                                                                                                              | whole design                                                                                    |
| G12 | Secrets leak through logs or errors                                      | Start-up errors name variables, never values; logs exclude pull request content and redact credentials; HTTP errors are generic                                                              | `api/config/env.ts`, `api/logger.ts`, `api/middleware/`                                         |
| G13 | Internal details leak in HTTP responses                                  | Fixed response bodies; no stack traces; `X-Powered-By` removed                                                                                                                               | `api/app.ts`                                                                                    |
| G14 | The container is compromised                                             | Runs as an unprivileged user, read-only file system, all capabilities dropped                                                                                                                | `docker/api.Dockerfile`, `compose.yaml`                                                         |
| G15 | A huge pull request exhausts memory                                      | Patches are capped at 1 million characters each and 10 million per review; the client drops patches past the budget as each page arrives, and the engine rejects input that exceeds it       | `github-client/api/octokit-client.ts`, `mapping/to-review-context.ts`, `review-engine/context/` |
| G16 | A malformed patch makes an invented line look verified                   | A hunk must contain exactly the lines its header declares, or none of its lines can verify a location                                                                                        | `review-engine/diff/parse-patch.ts`                                                             |
| G17 | GitHub rate limits leave reviews silently undone                         | Short rate limits are waited out and retried; longer ones fail the review with a distinct log message; a failed review's delivery can be redelivered                                         | `github-client/api/retry.ts`, `api/modules/github/webhook.router.ts`                            |
| G18 | A rule leaks source code into a stored or published finding              | Rules that read added lines report what was found and where, never the line's text; a test asserts it                                                                                        | `review-engine/rules/debug-statements.rule.ts`                                                  |
| G19 | A crafted line makes text matching slow                                  | Lines over 1,000 characters are skipped; expressions are simple and built only from validated method names                                                                                   | `review-engine/rules/debug-statements.rule.ts`                                                  |
| G20 | Re-reviewing floods a pull request with repeated line comments           | Comments are reconciled by fingerprint and capped at 20 per review                                                                                                                           | `github-client/output/inline-comments.ts`                                                       |
| G21 | PR Buddy deletes someone else's comment                                  | Only comments authored by the app itself and carrying its marker are ever deleted                                                                                                            | `github-client/api/octokit-client.ts`, `inline-comments.ts`                                     |
| G22 | Thresholds silently hide findings                                        | The number hidden is reported in the comment and stored with the review                                                                                                                      | `render-summary.ts`, `postgres-review-store.ts`                                                 |

### Known limits in Milestone 2

- **One page of GitHub's file listing is held in memory before it can be trimmed.** GitHub
  limits the size of that response itself; PR Buddy cannot bound it further without streaming.
- **Delivery memory and the queue live in the process.** After a restart a redelivered event is
  processed again. That is safe, because publishing updates one comment in place, but it costs a
  review. A database removes this limit; see D-018 in [BRAIN.md](BRAIN.md).
- **Rate limiting is per process and per client address.** Behind several instances or a proxy,
  set `TRUST_PROXY` correctly and rate-limit at the proxy as well.
- **Secrets come from environment variables.** A production deployment should inject them from a
  secret store.
- **There is no multi-tenant data yet.** Each review uses a token scoped to the installation that
  sent the event, and nothing is stored, so there is no cross-tenant data to protect.

## 6A. Threats and controls in Milestone 3 — storage

| #   | Threat                                                              | Control                                                                                                                                                       | Where                                           |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| S1  | SQL injection through repository names, rule output or delivery IDs | Every statement is parameterised; no SQL text is built from input. The only identifier placed in SQL, a test schema name, is checked against a strict pattern | `api/database/`, `api/modules/**/postgres-*.ts` |
| S2  | The database password leaks                                         | It is read from `DATABASE_URL` only, never logged; start-up errors name the variable; connection errors are logged by name and code, not message              | `api/config/env.ts`, `api/logger.ts`            |
| S3  | Stored source code becomes a liability                              | Titles, descriptions, patches, file contents and error messages are never stored                                                                              | `api/modules/reviews/postgres-review-store.ts`  |
| S4  | One tenant reads another's history                                  | Every read is limited in SQL to the installations of the signed-in session; see W1 in section 6C                                                              | `api/modules/history/postgres-history-store.ts` |
| S5  | A half-written review misleads later readers                        | A review, its rule executions and findings are written in one transaction                                                                                     | `postgres-review-store.ts`                      |
| S6  | Two instances both accept one delivery                              | Claiming is a single atomic statement that returns a row only to the first claimant                                                                           | `postgres-delivery-store.ts`                    |
| S7  | A storage outage takes reviews down                                 | Saving happens after publishing and its failure is logged, not raised. Readiness reports the outage                                                           | `review.service.ts`, `app.ts`                   |
| S8  | Instances starting together corrupt the schema                      | Migrations run in one transaction under an advisory lock                                                                                                      | `api/database/migrate.ts`                       |
| S9  | An edited migration silently diverges from the database             | Checksums of applied migrations are verified at start-up                                                                                                      | `api/database/migrate.ts`                       |

### Known limits

- **File paths are stored** inside findings. Protect the database as you would the repositories.
- **No retention limit.** Reviews are kept until deleted.
- **Encryption in transit depends on the connection string.** Use `sslmode=require` or stronger
  for a database that is not on the same private network.
- **The development database password is in `compose.yaml`.** It is for local development only
  and the port is not published.

## 6B. Threats and controls in Milestone 3 — AI review

Design: [DESIGN-AI.md](DESIGN-AI.md). None of this runs until an operator names a provider and a
repository opts in.

| #   | Threat                                                          | Control                                                                                                                                 | Where                                           |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| A1  | Code is sent to a third party nobody agreed to                  | Two switches, both off by default: the operator's provider and the repository's `ai.enabled`, read at the base commit                   | `api/modules/reviews/review.service.ts`         |
| A2  | A pull request tells the model what to write (prompt injection) | Content is one JSON document apart from fixed instructions. The reply is constrained by A3 to A6 whatever the model was persuaded to do | `ai-reviewer/prompt/build-prompt.ts`            |
| A3  | The model invents a file or a line                              | File and line are verified against the files that were sent; an unverifiable suggestion is dropped                                      | `ai-reviewer/output/to-findings.ts`             |
| A4  | The reply is malformed, huge or not what was asked for          | Length limit, JSON parse, schema per entry, at most 10 suggestions                                                                      | `ai-reviewer/output/parse-response.ts`          |
| A5  | The model overstates its certainty or raises an alarm           | Confidence fixed at 0.5; severity capped at `high`; rule ID and evidence set by PR Buddy                                                | `ai-reviewer/output/to-findings.ts`             |
| A6  | Model text creates links, mentions, images or HTML in a comment | Every suggestion is published through `escapeMarkdown`; suggestions are labelled as unverified model output                             | `github-client/output/render-summary.ts`        |
| A7  | Credentials are sent to the provider                            | Credential-like files and lockfiles are never selected; only lines visible in the diff are sent                                         | `ai-reviewer/prompt/select-files.ts`            |
| A8  | A large pull request runs up cost or hangs a review             | Budgets for files, characters, line length, output tokens and time; one request, no retry                                               | `ai-reviewer/limits.ts`, `ai-reviewer.ts`       |
| A9  | A provider outage or bad reply takes reviews down               | The reviewer returns a status and never throws; rule findings are published regardless                                                  | `ai-reviewer/ai-reviewer.ts`                    |
| A10 | Prompt or reply text leaks through logs or the database         | Only status, counts, tokens, duration and the error's name are logged or stored; suggestion text is not stored                          | `review.service.ts`, `postgres-review-store.ts` |
| A11 | A provider's name or model, once published, injects Markdown    | Both are checked against a strict pattern when the reviewer is created, and rendered as inline code                                     | `ai-reviewer/provider.ts`                       |
| A12 | A provider key leaks                                            | Keys are read from the environment once, redacted in logs, absent from errors, and never sent to the browser                            | `api/config/env.ts`, `api/logger.ts`            |
| A13 | A provider's error reply leaks the prompt                       | A failed reply becomes an error named after its HTTP status; its body is not read                                                       | `ai-reviewer/providers/http.ts`                 |
| A14 | Code is sent over an unencrypted connection                     | A base URL must be `https://`, or `http://` on the same machine; credentials, queries and fragments in it are refused                   | `ai-reviewer/providers/provider-settings.ts`    |
| A15 | A request is redirected to another AWS host or path             | The region is checked against a strict pattern and the model is one encoded path segment                                                | `provider-settings.ts`, `providers/bedrock.ts`  |
| A16 | A vendor SDK brings in a compromised dependency                 | No SDK is installed; each provider is one file over `fetch`, and request signing is implemented and tested here                         | `ai-reviewer/providers/`                        |
| A17 | A mis-set provider fails at the first pull request              | Settings are validated at start-up and the service refuses to start, naming the variable                                                | `api/config/env.ts`                             |

### Known limits

- **Prompt injection is bounded, not prevented.** A pull request can still persuade a model to
  write a misleading suggestion about a real line. It is published as an unverified suggestion
  with confidence 0.5, and it cannot carry a link, a mention or a location outside the diff.
- **Resistance to prompt injection is not measured.** The controls above are covered by tests
  with scripted replies; see the tracker for which providers have answered a real request.
- **AWS credentials come from the environment only.** A long-lived access key in a file is the
  weakest way to hold them. Prefer a Bedrock API key with a short lifetime or temporary
  credentials, scoped to `bedrock:InvokeModel` on the one model.
- **The model's name is published.** It appears in the comment and the database. An inference
  profile given as an ARN would show the AWS account number; use the profile ID instead.
- **A secret inside an ordinary source file is sent.** Files are excluded by name only; PR Buddy
  is not a secret scanner.

## 6C. Threats and controls in Milestone 3 — dashboard

Design: [DESIGN-DASHBOARD.md](DESIGN-DASHBOARD.md).

| #   | Threat                                                     | Control                                                                                                                 | Where                                              |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| W1  | One tenant reads another's history                         | Every statement filters by the session's installation IDs; hidden and missing both answer `404`                         | `api/modules/history/postgres-history-store.ts`    |
| W2  | Someone is signed in to an attacker's account (login CSRF) | Random `state` in a cookie and in the request, compared in constant time; the cookie is cleared after one use           | `api/modules/auth/auth.router.ts`                  |
| W3  | A GitHub user token leaks                                  | Used once at sign-in and dropped: never stored, logged or sent to the browser                                           | `auth.router.ts`, `github-client/oauth/`           |
| W4  | A session cookie is stolen by a script or over plain HTTP  | `HttpOnly`; `Secure` with the `__Host-` prefix on HTTPS; `PUBLIC_URL` must be HTTPS except on localhost                 | `api/modules/auth/session-cookie.ts`, `config/env` |
| W5  | A copy of the database yields working sessions             | Only the SHA-256 of each 256-bit random token is stored                                                                 | `api/modules/auth/postgres-session-store.ts`       |
| W6  | A session outlives its welcome                             | Fixed 8-hour lifetime, no renewal; sign-out deletes the row; expired rows are purged                                    | `postgres-session-store.ts`                        |
| W7  | Another site makes the browser act (CSRF)                  | The API is read-only; sign-out is a `POST` behind a `SameSite=Lax` cookie and an `Origin` check                         | `auth.router.ts`                                   |
| W8  | Stored text runs as script in the dashboard                | React renders all API data as text; no HTML insertion; CSP allows scripts from the dashboard's origin only, none inline | `apps/web/src`, `api/modules/web/`                 |
| W9  | A stored value becomes a malicious link                    | GitHub links are built from values checked against strict patterns; otherwise no link is rendered                       | `apps/web/src/github-links.ts`                     |
| W10 | The dashboard is framed to trick clicks                    | `frame-ancestors 'none'` and `X-Frame-Options: DENY`                                                                    | `api/modules/web/`                                 |
| W11 | The callback is used as an open redirect                   | It only ever redirects to fixed paths on the dashboard's own origin                                                     | `auth.router.ts`                                   |
| W12 | Sign-in or the read API is hammered                        | Rate limits per client address on `/auth` and `/api`; page size fixed at 25                                             | `api/app.ts`                                       |
| W13 | A hostile ID or cursor reaches a query                     | Path and query values are validated with Zod first, and every statement is parameterised                                | `api/modules/history/history.router.ts`            |
| W14 | The client secret leaks                                    | Read from the environment only, redacted in logs, never part of an error or a response                                  | `config/env.ts`, `logger.ts`                       |
| W15 | A half-configured dashboard exposes something              | Without all its settings and a database, its routes are not registered                                                  | `api/main.ts`, `config/env.ts`                     |

### Known limits

- **Access is a snapshot.** Losing access to an installation takes effect when the session ends,
  at most 8 hours later (D-050).
- **Anyone with access to an installation sees all of its history.** There are no roles, and
  GitHub lists an installation for a person who can reach any one of its repositories.
- **File paths are visible** in findings to everyone who can sign in for that installation.
- **Sessions store a GitHub ID and login** for up to 8 hours after sign-in, plus cleanup time.

## 6D. Threats and controls in Milestone 4 — deployment

Guide: [DEPLOYMENT.md](DEPLOYMENT.md). The controls marked "example stack" are in `deploy/`; a
deployment built another way has to provide its own.

| #   | Threat                                                          | Control                                                                                                                                         | Where                                          |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| P1  | Traffic is read or changed in transit                           | The example stack serves HTTPS only; port 80 redirects. `PUBLIC_URL` must be HTTPS except on localhost                                          | `deploy/Caddyfile`, `config/env.ts`            |
| P2  | A browser is downgraded to HTTP later                           | Over an HTTPS address every response carries `Strict-Transport-Security` for a year                                                             | `api/app.ts`                                   |
| P3  | The API or the database is reached around the proxy             | In the example stack neither publishes a port; only the proxy does                                                                              | `deploy/compose.yaml`                          |
| P4  | A deployment runs with a known database password                | The example stack has no default and refuses to start without one                                                                               | `deploy/compose.yaml`                          |
| P5  | A visitor escapes the rate limit by forging `X-Forwarded-For`   | The proxy replaces the header; the API trusts exactly the configured number of proxies                                                          | `deploy/compose.yaml`, `api/app.ts`            |
| P6  | Every visitor shares one rate limit, or the wrong one is used   | The service warns at start-up when the address is HTTPS and no proxy is trusted                                                                 | `config/env.ts`, `api/main.ts`                 |
| P7  | A compromised API container changes itself or gains privileges  | Unprivileged user, read-only file system, all capabilities dropped, no new privileges                                                           | `docker/api.Dockerfile`, `deploy/compose.yaml` |
| P8  | An oversized request ties up the service                        | The proxy refuses bodies over 2 MB; the API refuses webhook bodies over 1 MB                                                                    | `deploy/Caddyfile`, `webhook.router.ts`        |
| P9  | A restart silently drops reviews that were already acknowledged | Requests are stored before the webhook is acknowledged and recovered at start-up, at most three times within a day                              | `api/modules/reviews/pending-review-store.ts`  |
| P10 | History grows without limit and outlives its use                | Reviews are deleted after a configurable number of days, 365 by default                                                                         | `api/modules/reviews/retention.ts`             |
| P11 | Data stays behind after the app is uninstalled                  | The signed uninstall event deletes that installation's history and sessions; suspension ends its sessions                                       | `api/modules/github/installation-store.ts`     |
| P12 | A forged or replayed installation event deletes data            | The event passes the same signature check as every webhook; deletion is limited to the installation it names; applying it twice changes nothing | `webhook.router.ts`, `installation-store.ts`   |

### Known limits

- **One machine, no redundancy.** An outage loses webhooks until they are redelivered.
- **Recovery is at-least-once and for one instance.** A review interrupted after it published
  runs again and updates the same comment. Two instances would each recover the same requests.
- **A person removed from an organisation keeps dashboard access until their session ends.**
  GitHub does not send the app an event for that; only uninstall, suspension and repository
  removal end access at once.
- **Backups are manual.** The guide gives the commands; nothing schedules them.
- **The database connection inside the stack is unencrypted.** It never leaves the stack's
  private network. The service warns if `sslmode=disable` is used anywhere.
- **Secrets are in a file on the host.** `deploy/.env` must be readable by the operator alone.
  There is no integration with a secret manager.

## 6E. Threats and controls in Milestone 5 — customers' AI keys

Design: [DESIGN-AI-KEYS.md](DESIGN-AI-KEYS.md). This is the first place the service stores a
secret that is not its own.

| #   | Threat                                                         | Control                                                                                                      | Where                                          |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| K1  | A copy of the database reveals customers' keys                 | AES-256-GCM under a master key that is only in the environment; a new nonce for every save                   | `api/modules/ai-keys/secret-cipher.ts`         |
| K2  | A ciphertext is moved to another installation's row            | The installation ID and provider are authenticated with the ciphertext; decryption elsewhere fails           | `secret-cipher.ts`, `postgres-ai-key-store.ts` |
| K3  | A key is read back through the API or the browser              | No route returns it; responses carry the provider, model and last four characters only                       | `api/modules/ai-keys/ai-key.router.ts`         |
| K4  | A key appears in a log or an error                             | `apiKey` is redacted in logs; provider errors are reduced to a status (D-062); tests assert it with canaries | `api/logger.ts`, `ai-reviewer/providers/`      |
| K5  | A member who is not an owner redirects the organisation's code | Writes need the owner role, read from GitHub at sign-in; anything short of a clear yes is no                 | `github-client/oauth/`, `ai-key.router.ts`     |
| K6  | One tenant changes or uses another tenant's key                | Every statement is keyed by the installation; an installation outside the session answers `404`              | `postgres-ai-key-store.ts`                     |
| K7  | Another site makes a signed-in browser change a key (CSRF)     | `SameSite=Lax` cookie, an `Origin` check, and a custom header that a cross-site form cannot send             | `ai-key.router.ts`                             |
| K8  | A customer points the service at an internal address (SSRF)    | Customers choose a provider, never an address; hosts are fixed in code and the region is pattern-checked     | `ai-key.schema.ts`                             |
| K9  | A failing customer key sends code to the operator's provider   | An installation with a key never falls back                                                                  | `api/modules/reviews/review.service.ts`        |
| K10 | Nobody can tell who changed a key                              | An audit row per change: installation, user ID, action, time                                                 | `postgres-ai-key-store.ts`                     |
| K11 | A key outlives the installation                                | Uninstalling deletes it with the installation's other data                                                   | `api/modules/github/installation-store.ts`     |
| K12 | The feature runs without encryption                            | Without the master key its routes are not registered; a malformed master key stops start-up                  | `config/env.ts`, `api/app.ts`                  |
| K13 | The save route is used to test stolen keys in bulk             | It needs an owner's session and is rate limited with the rest of the API                                     | `api/app.ts`                                   |

### Known limits

- **The running service can decrypt.** Encryption protects backups and database access, not a
  takeover of the service itself. Customers should use a key made for PR Buddy, with a limit.
- **The master key is an environment variable.** A key service is the better home for a hosted
  service; the cipher is an interface so that one can be added.
- **The owner role is a snapshot** from sign-in, for at most eight hours.
- **The last four characters of a key are stored in clear**, to let an owner recognise it.

## 8. What PR Buddy does not claim

PR Buddy holds no security certification. It is not a replacement for dedicated secret scanning,
static analysis or dependency scanning, and its findings are advice for a human reviewer.
