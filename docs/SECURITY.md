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

| Control                      | Detail                                                      |
| ---------------------------- | ----------------------------------------------------------- |
| One runtime dependency       | `zod` only                                                  |
| Lockfile                     | `package-lock.json` is committed; CI installs with `npm ci` |
| Automated updates            | Dependabot for npm, GitHub Actions and the Docker image     |
| Audit                        | CI runs `npm audit` on production dependencies              |
| CI permissions               | The workflow token is read-only                             |
| No secrets in the repository | `.gitignore` excludes `.env` files and private keys         |

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
| S4  | One tenant reads another's history                                  | There is no read endpoint yet. Every review is tied to an installation so that reads can be scoped when they are added                                        | [DESIGN-STORAGE.md](DESIGN-STORAGE.md)          |
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

## 7. Requirements for later milestones

### Milestone 3 — AI review

| Requirement       | Detail                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Prompt injection  | PR content is data. Instructions found in code, comments or descriptions are never followed           |
| Output validation | Model output is parsed with the finding schema and passes the same location validation as rule output |
| Data minimisation | Send only the diff context a review needs; never credentials or unrelated files                       |
| Disclosure        | Document which provider receives code and how it handles it                                           |
| Budgets           | Token, cost and time limits per review                                                                |

## 8. What PR Buddy does not claim

PR Buddy holds no security certification. It is not a replacement for dedicated secret scanning,
static analysis or dependency scanning, and its findings are advice for a human reviewer.
