# Design: running PR Buddy for other people

What a hosted PR Buddy needs once it holds other people's history and keys: backups that
survive the server, a way to hear that something is wrong, a fair share of the review queue for
every installation, and a page that says who runs the service. Decisions are in
[BRAIN.md](BRAIN.md) (D-086 to D-091); threats and controls in [SECURITY.md](SECURITY.md),
section 6F.

Backups and watching are scripts in `deploy/`, for the example stack. They are not part of the
API: a service that is down cannot report itself, and a backup must not depend on the process
it protects.

## 1. Backups

### What is backed up, and what is not

| Item                                    | Where it is               | In the backup                            |
| --------------------------------------- | ------------------------- | ---------------------------------------- |
| Review history, sessions, audit events  | PostgreSQL                | Yes                                      |
| Installations' AI keys                  | PostgreSQL, **encrypted** | Yes, still encrypted                     |
| The master key that decrypts those keys | `deploy/.env`             | **No**                                   |
| The GitHub App's private key            | `deploy/.env`             | **No**                                   |
| Certificates                            | A Caddy volume            | No: they are issued again without effort |

The master key is left out on purpose (D-086): someone who obtains a backup then holds only
ciphertext. The price is that `deploy/.env` must be kept somewhere else, by hand, once. A
backup without it restores the history and loses every stored AI key.

### How

`deploy/backup.sh`, run nightly by cron:

1. `pg_dump` in PostgreSQL's custom format, from inside the database container.
2. Check the file: not empty, and `pg_restore --list` reads it. A dump that cannot be listed is
   deleted and the run fails.
3. Upload it to an S3 bucket, if one is configured.
4. Delete local copies older than seven days.
5. On failure, send an alert (section 2) and exit with an error.

The upload uses `curl` with AWS request signing, so the server needs no extra software (D-087).

### The bucket and the credential

- The server's credential may **write** objects to that one bucket and publish alerts. It
  cannot read, list or delete. A server that is taken over cannot destroy or read earlier
  backups.
- The bucket keeps versions, so an upload over an existing name does not replace it.
- Objects are deleted by the bucket's own rule after 30 days.
- The bucket is private and encrypted at rest by S3.

Restoring therefore needs a different, stronger credential: the operator's own.

### Restore

[DEPLOYMENT.md](DEPLOYMENT.md), section 6. A backup is trusted only after it has been restored
once; the tracker records when that was last done from the bucket.

## 2. Watching

`deploy/watch.sh`, run every five minutes by cron on the server. It checks:

| Check          | Problem when                                                                |
| -------------- | --------------------------------------------------------------------------- |
| Reachable      | `https://<site>/readyz` over the public address does not answer `200`       |
| Containers     | The proxy, the API or the database is not running                           |
| Certificate    | It expires within 14 days (Caddy renews at 30, so this means renewal fails) |
| Disk           | The root file system is more than 85% full                                  |
| Backup         | Backups are configured and the newest is older than 26 hours                |
| Failed reviews | Three or more reviews failed in the last 30 minutes                         |

It remembers the last result. An alert is sent when the set of problems **changes**: one
message when something breaks, one when it recovers, none in between (D-088). A message names
the site and the failing checks. It never contains a repository, a person or a secret.

### Where alerts go

Either or both, set in `deploy/ops.env`:

- an AWS SNS topic, which delivers email or SMS to whoever subscribed;
- a webhook that accepts `{"text": "..."}`, as chat tools do.

With neither set, the script still records problems and prints them, so cron's own mail or the
log shows them.

### What this cannot see

A server that is switched off, out of memory or cut off from the network sends nothing. That
case needs a watcher outside the server: the hosting provider's own alarm on the instance, or
any external uptime check. The guide says so, and the example deployment uses its provider's
alarm.

## 3. A fair share of the queue

Before this, every installation shared one queue: `REVIEW_CONCURRENCY` reviews at a time,
`REVIEW_QUEUE_LIMIT` waiting. One installation pushing to many pull requests could take every
slot and fill the waiting list, and everyone else's webhooks were then refused.

Now the queue knows which installation a job belongs to (D-089):

- **Who goes next.** When a slot frees, the queue picks the waiting job whose installation has
  the fewest reviews running; among equals, the installation that was served longest ago; among
  those, the job that arrived first. An installation with fifty waiting reviews delays its own
  work, not a neighbour's single one.
- **How many may wait.** One installation may have at most
  `REVIEW_QUEUE_LIMIT_PER_INSTALLATION` reviews waiting (default 20). Beyond that its webhook is
  answered `503` like a full queue, the request is forgotten so that GitHub's "Redeliver" can
  succeed later, and the log names the installation.

The guarantees of the queue are unchanged: one review at a time per pull request, at most one
waiting per pull request, and the overall limits.

Not limited here: AI spending. An installation with its own key pays its own provider; an
operator who offers a provider to everyone should set a budget at that provider.

## 4. Who runs this service

A stranger deciding whether to install the app needs to know who is behind the address and how
to reach them. Only the operator can say that, so the service asks for it (D-090):

| Setting                | Shown as                                                      |
| ---------------------- | ------------------------------------------------------------- |
| `OPERATOR_NAME`        | "This service is run by …"                                    |
| `OPERATOR_CONTACT`     | An email address or an `https://` address to write to         |
| `OPERATOR_PRIVACY_URL` | A link to the operator's own privacy policy, if they have one |
| `OPERATOR_TERMS_URL`   | A link to the operator's own terms, if they have any          |

All four are optional. They travel in `GET /auth/service`, which needs no session, together
with the number of days reviews are kept.

A page at `/privacy`, open to everyone, is built from two kinds of statement and keeps them
apart:

1. **What the software does**, which is the same on every deployment and is taken from the
   code's behaviour: what is stored and never stored, how long, what is deleted on uninstall,
   where code is sent and when, which cookie is set, and that GitHub and the chosen AI provider
   are the only other parties.
2. **Who runs this deployment**, from the settings above. When the operator has not said, the
   page says exactly that, and the service warns at start-up.

The page is a description, not a contract. It does not replace a privacy policy or terms where
the law asks for them; those remain the operator's texts, which the page links to (D-091).

The first page and the dashboard link to `/privacy`.

## 5. Limits

- One server. Backups and alerts make its loss survivable and visible; they do not prevent it.
- The watcher runs on the server it watches.
- A restore is a manual procedure.
- Queue fairness is per process. Several API instances would each be fair on their own.
- The privacy page is in English only.
