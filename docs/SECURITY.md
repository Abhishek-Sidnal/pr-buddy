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

## 6. Requirements for later milestones

Recorded now so the design does not paint itself into a corner.

### Milestone 2 — GitHub App

| Requirement                | Detail                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Webhook authentication     | Verify the `X-Hub-Signature-256` HMAC over the raw request body with a constant-time comparison; reject on failure                                                                                           |
| Idempotency                | Store delivery IDs; a repeated delivery does not create a second review                                                                                                                                      |
| Least privilege            | Request only the permissions enabled features need; document each one                                                                                                                                        |
| Installation-scoped tokens | Use short-lived installation tokens, never a personal token                                                                                                                                                  |
| Stale results              | Record the head commit SHA; a review of an old commit must not overwrite a newer one                                                                                                                         |
| Request limits             | Body size limit, rate limiting, safe error responses                                                                                                                                                         |
| Repository configuration   | Read it from the base branch, never from the pull request's own commits, so a contributor cannot switch off checks for their own change. Parse with a safe YAML loader and validate with the engine's schema |
| No checkout execution      | Never run a contributor's code, install its dependencies or run its scripts                                                                                                                                  |
| Secrets                    | Environment variables locally; a secret store in production                                                                                                                                                  |
| Tenant isolation           | Every query is scoped to the organization and installation                                                                                                                                                   |

### Milestone 3 — AI review

| Requirement       | Detail                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Prompt injection  | PR content is data. Instructions found in code, comments or descriptions are never followed           |
| Output validation | Model output is parsed with the finding schema and passes the same location validation as rule output |
| Data minimisation | Send only the diff context a review needs; never credentials or unrelated files                       |
| Disclosure        | Document which provider receives code and how it handles it                                           |
| Budgets           | Token, cost and time limits per review                                                                |

## 7. What PR Buddy does not claim

PR Buddy holds no security certification. It is not a replacement for dedicated secret scanning,
static analysis or dependency scanning, and its findings are advice for a human reviewer.
