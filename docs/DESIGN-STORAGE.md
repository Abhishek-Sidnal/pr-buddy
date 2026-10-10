# PR Buddy — Storage Design

Detailed design of the first part of Milestone 3: PostgreSQL storage for review history and
webhook deliveries. The service that uses it is described in
[DESIGN-GITHUB.md](DESIGN-GITHUB.md).

## 1. What this delivers

- Every review, with its findings and the version of each rule that ran, is recorded.
- Webhook deliveries are remembered in the database, so a restart no longer forgets them and
  several instances share one memory.
- A readiness endpoint reports whether the database can be reached.

It does not yet deliver a way to read the history over HTTP. That arrives with the dashboard,
together with sign-in, because history must not be readable without knowing who is asking.

## 2. The database is optional

| `DATABASE_URL` | Deliveries are remembered | Reviews are recorded |
| -------------- | ------------------------- | -------------------- |
| not set        | in process memory         | no                   |
| set            | in PostgreSQL             | in PostgreSQL        |

Without a database the service behaves exactly as in Milestone 2. A self-hosted installation that
only wants comments on pull requests needs nothing more than the three GitHub settings.

## 3. Schema

```
repositories ──< reviews ──< findings
                    ├──────< rule_executions
                    └─────── ai_reviews (at most one)

webhook_deliveries
schema_migrations
```

| Table                  | One row per                             | Key columns                                                                        |
| ---------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| `repositories`         | GitHub repository PR Buddy has seen     | `id` (GitHub's), `installation_id`, `owner`, `name`                                |
| `reviews`              | review attempt                          | `repository_id`, `pull_request_number`, `head_sha`, `status`, timings, counts      |
| `findings`             | finding of a completed review           | `review_id`, `rule_id`, `severity`, `confidence`, `message`, `evidence`            |
| `rule_executions`      | rule in a completed review              | `review_id`, `rule_id`, `rule_version`, `status`                                   |
| `ai_reviews`           | review in which a model was asked       | `review_id`, `provider`, `model`, `status`, counts, token usage, duration          |
| `webhook_deliveries`   | delivery accepted in the last day       | `delivery_id`, `received_at`                                                       |
| `sessions`             | signed-in browser, for 8 hours          | `token_hash`, `user_id`, `login`, `installation_ids`, `expires_at`                 |
| `installation_ai_keys` | installation that stored its own AI key | `installation_id`, `provider`, `model`, `resource`, encrypted key, last four chars |
| `audit_events`         | change to an AI key                     | `installation_id`, `user_id`, `action`, `occurred_at`                              |
| `schema_migrations`    | applied migration                       | `name`, `checksum`                                                                 |

`reviews.suppressed_finding_count` records how many findings a repository's reporting thresholds
hid from that review.

`reviews.status` is `completed`, `skipped` or `failed`. A skipped review records why (`draft`,
`closed`, `stale`). A failed review records the error's name and HTTP status, never its message.

Every review belongs to a repository, and every repository to a GitHub App installation. That
chain is what later lets a query be limited to the installations a signed-in user may see.

### What is stored, and what is not

| Stored                                                         | Not stored                           |
| -------------------------------------------------------------- | ------------------------------------ |
| Repository owner and name                                      | Pull request titles and descriptions |
| Pull request number, base and head commit IDs                  | Patches and file contents            |
| Findings: rule, severity, message, evidence, file path, line   | Rule error messages                  |
| Counts, timings, the comment action taken                      | Tokens, secrets, webhook bodies      |
| AI review: provider, model, status, counts, token usage        | The text of AI suggestions           |
| An installation's AI key, encrypted under a key held elsewhere | Any AI key in clear                  |

AI suggestions are published on the pull request and nowhere else: a model that has read the code
may quote it (D-046). Their rows in `ai_reviews` say that suggestions were made, not what they
said.

Findings contain file paths, which come from the repository. Anyone who can read the database can
therefore learn file names from the repositories PR Buddy reviewed.

There is no retention limit yet: reviews are kept until deleted. Deleting a repository's row
deletes its reviews and their findings.

## 4. Recording a review

The review service records the outcome after it has published, in one transaction: the
repository is inserted or updated, then the review, its rule executions and its findings.

| Situation                                  | What happens                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Review completed                           | Recorded with findings and rule versions                                            |
| Review skipped                             | Recorded with the reason                                                            |
| Review failed                              | Recorded with the error name; the failure is still raised                           |
| The database cannot be reached when saving | Logged. The review itself is not failed: its comment is already on the pull request |

## 5. Remembering deliveries

Claiming a delivery is one statement: insert the ID, or, if a row older than 24 hours exists,
take it over. The statement returns a row only when the delivery is new, so two instances
receiving the same delivery cannot both accept it. Releasing a delivery deletes its row. Expired
rows are purged from time to time by the claims themselves; no scheduler is needed.

## 6. Migrations

Plain SQL files in `apps/api/migrations`, named `NNNN_description.sql`, applied in order when the
service starts.

- All pending migrations run in one transaction; a failure leaves the database unchanged.
- A PostgreSQL advisory lock makes instances that start together apply them once.
- Each applied file's SHA-256 is stored. If an applied file is later edited, start-up fails
  rather than running with a schema that no longer matches its history.
- Migrations only move forward. To undo one, write a new migration.

## 7. Configuration

| Variable             | Required | Default | Meaning                                       |
| -------------------- | -------- | ------- | --------------------------------------------- |
| `DATABASE_URL`       | no       |         | `postgres://user:password@host:port/database` |
| `DATABASE_POOL_SIZE` | no       | `5`     | Most connections the service opens            |

`GET /readyz` answers `200` when the service can serve requests, which with a database means a
query succeeds, and `503` otherwise. `GET /healthz` still answers `200` whenever the process is
up.

## 8. Testing

Storage is tested against a real PostgreSQL, not a stand-in, because the behaviour that matters
(conflicts, transactions, cascades, locks) lives in the database. Each test file works in its own
schema and drops it afterwards. `TEST_DATABASE_URL` points at the server; the development
container and CI both provide one.

The in-memory and PostgreSQL delivery stores run the same contract tests.

## 9. Looking at the history

The dashboard reads the history for people ([DESIGN-DASHBOARD.md](DESIGN-DASHBOARD.md)). For
anything it does not show, SQL still works. With the development database:

```bash
docker compose exec postgres psql -U prbuddy -d prbuddy
```

```sql
-- The latest reviews, newest first
SELECT r.owner, r.name, v.pull_request_number, v.status, v.finding_count, v.completed_at
FROM reviews v
JOIN repositories r ON r.id = v.repository_id
ORDER BY v.started_at DESC
LIMIT 20;

-- How often each rule reports
SELECT rule_id, severity, count(*) FROM findings GROUP BY rule_id, severity ORDER BY 3 DESC;
```

## 10. Pending reviews: surviving a restart

A webhook is acknowledged before its review runs, so a restart between the two used to lose the
review. `pending_reviews` closes that gap (D-066).

| Column                                 | Meaning                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `repository_id`, `pull_request_number` | The key: one row per pull request, like the queue's own coalescing |
| `installation_id`, `owner`, `name`     | What is needed to fetch the pull request again                     |
| `generation`                           | Raised by every new request for the same pull request              |
| `attempts`                             | Reviews of this request that failed                                |
| `requested_at`                         | When the latest request arrived                                    |

```
webhook ──► upsert row (generation n) ──► 202 ──► queue ──► review
                                                              ├─ finished: delete the row if it is still generation n
                                                              └─ failed:   attempts + 1
start-up ──► drop rows older than 24 h or with 3 attempts ──► queue the rest
```

The generation is what makes a late finish harmless: if a push arrives while a review runs, the
row moves to the next generation, the finishing review deletes nothing, and the queued review
for the new push deletes it when it is done.

Recovery is at-least-once. A review that was interrupted after it published its comment runs
again and updates the same comment. A row holds identifiers only: no title, no commit, no code.

Without a database there is nothing to recover from, and the service behaves as before.

## 11. Retention

Reviews older than `REVIEW_RETENTION_DAYS` (default 365; `0` keeps everything) are deleted with
their findings, rule executions and AI records (D-068). The job runs at start-up and once a day,
in batches of 1,000 reviews, outside any request or review. It also removes expired sessions.
A repository's row stays, so a repository whose reviews have all aged out is listed with none.

**Upgrading:** the first start of a version with retention deletes reviews older than the limit.
Set the variable beforehand to keep them.

## 12. When an installation changes

GitHub tells the app when it is uninstalled, suspended, or loses a repository. These events are
verified like every webhook and carry only IDs (D-069).

| Event                                           | Sessions that list the installation | Stored history                    |
| ----------------------------------------------- | ----------------------------------- | --------------------------------- |
| `installation` `deleted`                        | Ended                               | Deleted, for all its repositories |
| `installation` `suspend`                        | Ended                               | Kept                              |
| `installation_repositories` `removed`           | Ended                               | Deleted, for those repositories   |
| Anything else, including `created`, `unsuspend` | Untouched                           | Untouched                         |

A person whose session is ended signs in again and sees whatever GitHub lists for them then.
Losing access in a way GitHub does not announce to the app, such as leaving an organisation,
still takes effect when the session ends (D-050).
