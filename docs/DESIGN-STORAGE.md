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
                    └──────< rule_executions

webhook_deliveries
schema_migrations
```

| Table                | One row per                         | Key columns                                                                   |
| -------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `repositories`       | GitHub repository PR Buddy has seen | `id` (GitHub's), `installation_id`, `owner`, `name`                           |
| `reviews`            | review attempt                      | `repository_id`, `pull_request_number`, `head_sha`, `status`, timings, counts |
| `findings`           | finding of a completed review       | `review_id`, `rule_id`, `severity`, `confidence`, `message`, `evidence`       |
| `rule_executions`    | rule in a completed review          | `review_id`, `rule_id`, `rule_version`, `status`                              |
| `webhook_deliveries` | delivery accepted in the last day   | `delivery_id`, `received_at`                                                  |
| `schema_migrations`  | applied migration                   | `name`, `checksum`                                                            |

`reviews.suppressed_finding_count` records how many findings a repository's reporting thresholds
hid from that review.

`reviews.status` is `completed`, `skipped` or `failed`. A skipped review records why (`draft`,
`closed`, `stale`). A failed review records the error's name and HTTP status, never its message.

Every review belongs to a repository, and every repository to a GitHub App installation. That
chain is what later lets a query be limited to the installations a signed-in user may see.

### What is stored, and what is not

| Stored                                                       | Not stored                           |
| ------------------------------------------------------------ | ------------------------------------ |
| Repository owner and name                                    | Pull request titles and descriptions |
| Pull request number, base and head commit IDs                | Patches and file contents            |
| Findings: rule, severity, message, evidence, file path, line | Rule error messages                  |
| Counts, timings, the comment action taken                    | Tokens, secrets, webhook bodies      |

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

Until the dashboard exists, the history is read with SQL. With the development database:

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
