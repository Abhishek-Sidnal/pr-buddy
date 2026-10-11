# Design: running PR Buddy for other people

What a hosted PR Buddy needs once it holds other people's history and keys: backups that
survive the server, a way to hear that something is wrong, a fair share of the review queue for
every installation, and a page that says who runs the service. Decisions are in
[BRAIN.md](BRAIN.md) (D-086 to D-094); threats and controls in [SECURITY.md](SECURITY.md),
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

## 5. What the operator can see

Someone who runs PR Buddy for others needs to answer three questions without opening a
database: is it being used, is it working, and who is having trouble. A page of the dashboard
answers them, for the operator only (D-092, D-093).

### Who is the operator

`OPERATOR_GITHUB_USER_IDS` lists GitHub's numeric user IDs, separated by commas. A session
whose user ID is in the list is an operator's. IDs are used, not logins: a login can be given up
and registered again by someone else, an ID cannot. Without the setting nobody is an operator
and the page and its route do not exist.

`GET /api/me` says whether the signed-in person is an operator, so that the dashboard can show
the link. Being told "yes" grants nothing: the route checks the session itself.

### What it shows

`GET /api/operator/overview`, and the page at `/operator`:

| Section           | Content                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| Totals            | Installations and repositories that have been reviewed                                              |
| Reviews           | Completed, skipped and failed in the last 24 hours, 7 days and 30 days                              |
| AI reviews        | Completed, skipped and failed in the last 30 days                                                   |
| Right now         | Reviews running and waiting in this process; requests not yet finished, and the oldest              |
| Stored AI keys    | How many, by provider                                                                               |
| Signed in         | People with a session that has not ended                                                            |
| Each installation | Account, repositories, reviews and failures in 30 days, last review, AI provider if a key is stored |

The installation list is the hundred most recently active.

### What it never shows

Repository names, pull request numbers, findings, file paths, people's logins, and keys. An
operator can read the database anyway; the point is that a browser session, which can be
stolen, should carry counts and account names and nothing a customer would call their work.

### How it differs from every other read

Every other dashboard query is limited in SQL to the session's installations (D-054). These
queries are deliberately not: they cross installations. They therefore live in a store of
their own, reachable only through a router that first checks the operator list, and that
answers `404` to everyone else, exactly as for a path that does not exist. The service logs
each read with the operator's user ID.

## 6. A second app for development

One GitHub App delivers its webhooks to one address. Once that address is the public server,
a developer's own machine receives nothing, and a change can only be tried in production.
The answer is a second, private app whose webhooks go to the developer's relay (D-094).

Registering an app by hand takes a dozen fields and five secrets copied one at a time. GitHub
can instead create an app from a description, a manifest, in one click. A command does that:

```
register-app --webhook-url <relay address> [--name <app name>] [--public-url http://localhost:3000]
```

1. It starts a page on the developer's machine with one button.
2. The button sends GitHub the manifest: the name, the relay address, the callback and setup
   addresses for `--public-url`, the three permissions PR Buddy needs, the pull request event,
   and "private".
3. The developer confirms on GitHub. GitHub sends the browser back with a one-time code.
4. The command checks that the request is the one it started, exchanges the code with GitHub
   for the app's ID, private key, webhook secret, client ID and client secret, and writes them
   into the environment file. The previous file is kept beside it.
5. It prints the app's name and where to install it. It never prints a secret.

The same command suits an operator registering their first app, with `--public` and their
server's address.

What it does not do: install the app on a repository, which only its owner can, or change an
app that already exists.

## 7. Limits

- One server. Backups and alerts make its loss survivable and visible; they do not prevent it.
- The watcher runs on the server it watches.
- A restore is a manual procedure.
- Queue fairness is per process. Several API instances would each be fair on their own.
- The privacy page is in English only.
