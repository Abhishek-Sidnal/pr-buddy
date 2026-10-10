# PR Buddy — GitHub App Design

Detailed design of Milestone 2: `@pr-buddy/github-client` and `@pr-buddy/api`. The engine they
call is described in [DESIGN.md](DESIGN.md). To register and run the app, see
[GITHUB_APP.md](GITHUB_APP.md).

## 1. What Milestone 2 delivers

When a pull request is opened or updated in a repository where the app is installed, PR Buddy
reviews it and keeps exactly one summary comment on the pull request up to date.

```
GitHub ──POST /webhooks/github──► API
                                   │ 1 limit body size, rate-limit
                                   │ 2 verify HMAC signature over the raw body
                                   │ 3 drop repeated deliveries
                                   │ 4 parse and filter the event
                                   │ 5 queue a review, answer 202
                                   ▼
                              review queue ── one review at a time per pull request
                                   │
                                   ▼
                              review service
                                   │ 1 fetch the pull request; skip drafts and closed ones
                                   │ 2 fetch changed files
                                   │ 3 load configuration from the base commit
                                   │ 4 run the review engine
                                   │ 5 fetch the pull request again; discard if the head moved
                                   │ 6 create or update the summary comment
                                   ▼
                                GitHub
```

Milestone 2 keeps no database. See decision D-018 in [BRAIN.md](BRAIN.md).

## 2. Packages

| Package                   | Responsibility                                                                  | Depends on                                |
| ------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| `@pr-buddy/github-client` | Everything that knows GitHub's formats: signatures, events, API calls, Markdown | `review-engine`, Octokit, `zod`           |
| `@pr-buddy/api`           | HTTP server, queue, review orchestration, configuration from the environment    | `github-client`, `review-engine`, Express |

The API never imports Octokit. It talks to GitHub through the `RepositoryClient` interface, so
every flow is tested with an in-memory fake.

## 3. Webhook endpoint

`POST /webhooks/github`

| Step | Check                                                     | Failure response         |
| ---- | --------------------------------------------------------- | ------------------------ |
| 1    | Request rate per client address                           | `429`                    |
| 2    | Body no larger than 1 MB                                  | `413`                    |
| 3    | `X-Hub-Signature-256` matches HMAC-SHA256 of the raw body | `401`                    |
| 4    | `X-GitHub-Delivery` is present and well-formed            | `400`                    |
| 5    | Delivery ID not seen before                               | `202` `duplicate`        |
| 6    | Body is JSON                                              | `400`                    |
| 7    | Event is a reviewable `pull_request` action               | `202` `ignored`          |
| 8    | Queue has room                                            | `503`, delivery released |

On success the response is `202` with `{"status":"queued"}`. The review itself runs after the
response, because GitHub expects an answer within ten seconds.

The signature is checked before anything in the body is parsed, and with a constant-time
comparison. The `ping` event GitHub sends when a webhook is created is answered with `200`.

Reviewable actions: `opened`, `reopened`, `synchronize`, `ready_for_review`, `edited`.

The event payload is only a trigger. The review service fetches the pull request from the API, so
it never acts on a title, description or commit taken from a webhook body.

## 4. Review queue

An in-process queue with four guarantees:

- **One review at a time per pull request.** Two reviews of the same pull request can never
  publish out of order.
- **Coalescing.** If a review of a pull request is already waiting, a new trigger for it is merged
  into the waiting one. A burst of pushes produces one review, not ten.
- **Bounded.** At most `REVIEW_CONCURRENCY` reviews run at once and at most `REVIEW_QUEUE_LIMIT`
  wait. Beyond that the webhook answers `503` and the delivery can be sent again from GitHub.
- **Fair between installations.** A free slot goes to the installation with the fewest reviews
  running, then to the one served longest ago, then to the job that arrived first. One
  installation may have at most `REVIEW_QUEUE_LIMIT_PER_INSTALLATION` reviews waiting; beyond
  that its webhook answers `503` as for a full queue (D-089).

With a database, a review that was requested but had not finished when the process stopped is
run again at the next start: the request is stored before the webhook is acknowledged
([DESIGN-STORAGE.md](DESIGN-STORAGE.md), section 10). Without a database a queued review is lost
with the process, and a later event on the pull request, or a redelivery, triggers a fresh one.

The same endpoint receives `installation` and `installation_repositories` events and cleans up
when the app is uninstalled, suspended or loses a repository (DESIGN-STORAGE.md, section 12).

When a review fails, its delivery ID is forgotten. GitHub's "Redeliver" reuses the delivery ID, so
this is what allows a failed review to be run again instead of being dropped as a duplicate.

## 5. Review service

| Situation                                                 | Outcome                                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Pull request is closed or merged                          | Skipped                                                                                                                           |
| Pull request is a draft                                   | Skipped; reviewed when marked ready                                                                                               |
| Head commit changed while the review ran                  | Result discarded; the newer event has its own review. See "Stale results" below                                                   |
| No findings and no earlier PR Buddy comment               | Nothing is posted                                                                                                                 |
| No findings but an earlier comment exists                 | The comment is updated to say so                                                                                                  |
| Findings                                                  | The comment is created or updated                                                                                                 |
| Repository configuration is invalid                       | Defaults are used and the comment says why                                                                                        |
| A file cannot be represented safely                       | The file is skipped and the comment says how many                                                                                 |
| GitHub returns a server error                             | The call is retried up to three times with back-off                                                                               |
| GitHub returns a rate limit (429, or a 403 marked as one) | The call waits as long as GitHub asks, up to 60 seconds, and is retried up to three times. A longer wait fails the review at once |
| GitHub returns another client error                       | The review fails and is logged; nothing is posted                                                                                 |
| A review fails                                            | Logged, with a separate message for rate limits; its delivery can be redelivered                                                  |
| A diff is too large to load                               | The file is reviewed by name only and the comment says how many                                                                   |
| The repository enabled AI review and a provider exists    | A model is asked once, after the rules; its verified suggestions get their own section. See [DESIGN-AI.md](DESIGN-AI.md)          |
| The AI review fails                                       | The rules' findings are published and the comment says the AI review could not be completed                                       |

### Stale results

Three things keep a review of an old commit off the pull request:

1. Reviews of one pull request run one at a time, so two can never publish out of order.
2. The pull request is fetched again immediately before publishing. If the head commit moved, or
   the pull request was closed, the result is thrown away.
3. Every push triggers its own review, which replaces the comment.

This narrows the window; it does not close it. A push can arrive after the check in step 2 and
before the comment call completes, and GitHub has no way to make a comment conditional on the
head commit. In that case the old result is visible until the review from step 3 finishes, which
is normally a few seconds. The comment always names the commit it describes.

### Repository configuration

PR Buddy reads `.github/pr-buddy.json` at the pull request's **base** commit. A contributor
therefore cannot weaken the checks that apply to their own pull request by editing the file in
that pull request. The file has the format in [DESIGN.md](DESIGN.md) section 4, is limited to
64 KB, and is validated by the engine.

One section is not the engine's: `"ai": { "enabled": true }` allows the repository's pull
requests to be sent to the operator's AI provider. The service takes it out and validates it
before the engine sees the rest. If any part of the file is invalid, defaults are used for all of
it, and the default for AI review is off.

### The summary comment

- One comment per pull request, found again by a hidden marker and by the app that wrote it. A
  comment by anyone else that copies the marker is ignored.
- Evidence values, which can contain file names chosen by a contributor, are rendered as code so
  they cannot create mentions, links or HTML.
- Messages are escaped, and `@` is neutralised so a finding cannot notify people.
- Rule error messages are never published; the comment only says how many rules could not run.
- The body is capped below GitHub's comment size limit.

## 6. Mapping GitHub data to the engine

| GitHub                                        | Review context                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `filename`                                    | `path`                                                                       |
| `status` `changed`                            | `modified`                                                                   |
| `status` `unchanged`                          | file skipped                                                                 |
| `renamed` without a previous name             | `modified`                                                                   |
| `patch` longer than the engine allows         | patch dropped; the file is kept without it                                   |
| patches beyond 10 million characters in total | further patches dropped, during retrieval and again when mapping; files kept |
| a path the engine rejects                     | file skipped and counted                                                     |
| title or body beyond the limit                | truncated                                                                    |

## 7. Configuration of the API

All settings come from environment variables and are validated at start-up. A problem stops the
process with a message that names the variable and never prints its value.

| Variable                | Required | Default | Meaning                                                           |
| ----------------------- | -------- | ------- | ----------------------------------------------------------------- |
| `GITHUB_APP_ID`         | yes      |         | Numeric ID of the GitHub App                                      |
| `GITHUB_PRIVATE_KEY`    | yes      |         | The app's private key in PEM form; `\n` may stand for line breaks |
| `GITHUB_WEBHOOK_SECRET` | yes      |         | Webhook secret, at least 16 characters                            |
| `PORT`                  | no       | `3000`  | Port to listen on                                                 |
| `LOG_LEVEL`             | no       | `info`  | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`    |
| `TRUST_PROXY`           | no       | `0`     | Number of reverse proxies in front of the API                     |
| `REVIEW_CONCURRENCY`    | no       | `2`     | Reviews that may run at once                                      |
| `REVIEW_QUEUE_LIMIT`    | no       | `100`   | Reviews that may wait                                             |
| `WEBHOOK_RATE_LIMIT`    | no       | `300`   | Webhook requests allowed per minute per client address            |

## 8. GitHub App permissions

| Permission                           | Access | Used for                                           |
| ------------------------------------ | ------ | -------------------------------------------------- |
| Metadata                             | read   | Required by GitHub for every app                   |
| Pull requests                        | write  | Read pull requests and files; write the comment    |
| Single file: `.github/pr-buddy.json` | read   | Read the repository configuration and nothing else |

Subscribed event: **Pull request**. PR Buddy does not request access to repository contents,
issues, checks or workflows.

**Verified against GitHub on 2026-10-10.** An app registered with exactly these three permissions
read `.github/pr-buddy.json` at a pull request's base commit and applied it. "Single file" is
listed in GitHub's REST documentation as `single_file`, with the paths in `single_file_paths`;
in an app manifest the path is given as `single_file_name`. See D-028 in [BRAIN.md](BRAIN.md).

## 9. Logging

Structured JSON on standard output. Each review logs the repository, pull request number,
delivery ID, outcome and duration. Titles, descriptions, patches, file contents, tokens and
secrets are never logged.

## 10. Testing strategy

| Layer           | What it proves                                                           |
| --------------- | ------------------------------------------------------------------------ |
| Unit            | Signature check, event parsing, mapping, rendering, queue, stores, retry |
| Service         | Every row of the table in section 5, against an in-memory GitHub fake    |
| HTTP            | Every row of the table in section 3, through the real Express app        |
| Octokit adapter | Requests and pagination against a stubbed `fetch`                        |
| End to end      | Signed webhook in, comment out, with only GitHub replaced by the fake    |

A test against the real GitHub API needs a registered app and is a manual step described in
[GITHUB_APP.md](GITHUB_APP.md).

## 11. Comments on lines

A finding that has a verified file and line is posted twice: in the summary comment, which lists
every finding, and as a comment on its line.

| Step | What happens                                                                            |
| ---- | --------------------------------------------------------------------------------------- |
| 1    | List the line comments this app has already left on the pull request                    |
| 2    | Give each located finding a fingerprint: a hash of its rule, file, line and message     |
| 3    | Delete the app's comments whose fingerprint matches no current finding, and any repeats |
| 4    | Post the findings that have no comment yet, as one review, on the reviewed commit       |

Each comment carries its fingerprint in a hidden marker. A finding that already has its comment
is left alone, so reviewing again repeats nothing. A comment without the marker is never touched,
and neither is a comment by anyone else: the app's own comments are recognised by their author,
`<app slug>[bot]`, which is looked up once.

| Situation                     | Outcome                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| A push moves a flagged line   | The old comment is deleted and a new one is posted at the new line |
| The flagged code is removed   | The comment is deleted                                             |
| More than 20 located findings | The first 20 get line comments; all appear in the summary          |
| Posting line comments fails   | Logged as a warning. The review and its summary stand              |
| The review is stale           | No line comments are posted, as with the summary                   |

A new comment goes out in a single review, so one review sends one notification however many
lines it comments on. No extra GitHub permission is needed: line comments use the pull request
permission the app already has.
