# Changelog

Notable changes to PR Buddy. The format follows [Keep a Changelog](https://keepachangelog.com/),
and versions follow [Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version may
change behaviour or configuration; such changes are listed under "Upgrade notes".

## [Unreleased]

### Added

- A **Service** page for the people who run a deployment, at `/operator`: installations and
  repositories reviewed, reviews and AI reviews by outcome over 24 hours, 7 days and 30 days,
  what is running and waiting, stored AI keys by provider, and one row per installation with
  its account, activity, failures and AI provider. Set `OPERATOR_GITHUB_USER_IDS` to the GitHub
  user IDs that may see it. It shows no repository name, pull request, finding or login, and
  everyone else finds nothing at its address.
- `register-app`, a command that registers a GitHub App from a manifest and writes its
  credentials to an environment file: one click on GitHub in place of a dozen fields and five
  secrets. Meant first for a private app of your own for development. See `docs/GITHUB_APP.md`,
  section 2.
- `GET /api/me` says whether the signed-in person is an operator.

### Fixed

- An owner of an organisation was never recognised as one, so no organisation could store its
  own AI key. GitHub refuses the question PR Buddy asks unless the app has the organisation
  permission **Members: read**. The registration command now requests it, the guide lists it,
  and a failed owner check is logged with its reason.

### Upgrade notes

- The operator's page does not exist until `OPERATOR_GITHUB_USER_IDS` is set.
- **Add the organisation permission "Members: Read-only" to your GitHub App** (its settings,
  Permissions and events). Each organisation that installed the app must then approve it;
  until it does, nobody there is treated as an owner. Personal accounts are not affected.

## [0.3.0] — 2026-10-10

A hosted PR Buddy that a stranger can start with and an operator can keep running: a first
page with an Install button, a public privacy page, a queue shared fairly between
installations, nightly backups and alerts.

### Added

- The dashboard's first page now explains PR Buddy to someone who is new: what it does, how to
  start, what it stores, and what GitHub shares at sign-in. With `GITHUB_APP_SLUG` set it offers
  an **Install on GitHub** button.
- Until a first review exists, the overview shows a "Getting started" list. Each step's state
  comes from what the service knows: whether the app is installed, whether a review exists, and
  whether an installation has an AI key.
- `GET /auth/service` tells a visitor's browser what the operator configured for the public: the
  app's name, who runs the service, and how long reviews are kept. It needs no session.
- A public page at `/privacy` states what the software stores, sends and deletes, and shows who
  runs the deployment when the operator has set `OPERATOR_NAME` and `OPERATOR_CONTACT`. It can
  link to the operator's own policy and terms (`OPERATOR_PRIVACY_URL`, `OPERATOR_TERMS_URL`).
- The review queue is shared fairly between installations: a free slot goes to the installation
  with the least running work, then the one served longest ago. One installation may have at
  most `REVIEW_QUEUE_LIMIT_PER_INSTALLATION` reviews waiting (default 20); beyond that its
  webhook is answered `503`, as for a full queue.
- `deploy/backup.sh` backs the database up every night: it checks the dump, copies it to an S3
  bucket with a credential that can only write, and alerts when it fails.
- `deploy/watch.sh` checks reachability, containers, the certificate, disk space, backups and
  failed reviews every five minutes, and alerts by AWS SNS or a webhook when the set of problems
  changes, including when it clears.

### Changed

- The sign-in page is replaced by that first page. Sign-in works as before.
- The service warns at start-up when the dashboard is on and `GITHUB_APP_SLUG` is not set.

### Upgrade notes

- To send people to the dashboard after they install the app, set the app's **Setup URL** on
  GitHub to `<PUBLIC_URL>/auth/login`. See `docs/GITHUB_APP.md`, section 7.
- Set `OPERATOR_NAME` and `OPERATOR_CONTACT`, or the public privacy page says that the operator
  has not published who they are.
- An installation with more than 20 reviews waiting now has further webhooks refused until some
  have run. Raise `REVIEW_QUEUE_LIMIT_PER_INSTALLATION` if that is too low for you.
- Copy the new files in `deploy/` to the server to use the backup and watch scripts, and keep a
  copy of `deploy/.env` somewhere else: it is deliberately not part of a backup.

### Verified, and not

Verified on the public deployment: a second GitHub account signing in after the app was made
public; a nightly-style backup copied to a bucket, with the server's credential refused for
reading, listing and deleting; a restore from the bucket into a scratch database on another
machine with matching row counts; a rehearsed alert (one message on failure, none while nothing
changed, one on recovery); the watcher running from cron.

Verified in the built image on a development machine: the first page with a working Install
link, the getting-started list for an installation without reviews, and the privacy page.

Reported by the maintainer and not observed by the tests or on the server: a second account
installing the app from the first page and arriving on the dashboard signed in.

Not verified:

- An alert reaching a person. The rehearsal published to the topic; nobody was subscribed.
- An alarm outside the server, for the case where the server itself is down.
- A scheduled backup observed over a night.
- A review for a second installation on the public deployment, and queue fairness under real
  load from two installations. Fairness is covered by tests.
- Azure against a real resource, the owner check for an organisation, and uninstalling or
  suspending the app on the public deployment, as in 0.2.0.

Known limits: one server; the watcher runs on the server it watches; a restore is a manual
procedure; the privacy page is in English and is a description of the software, not a legal
policy.

## [0.2.0] — 2026-10-10

PR Buddy can now be run for other people: each installation brings its own AI provider, and
the stack runs on a small server from an image that CI publishes.

### Added

- An installation can store its own AI provider and key, so that its reviews go to a provider it
  chose and pays for. Owners of the account manage it on the settings page; the key is checked
  with the provider, stored encrypted, never shown again, and deleted on uninstall. Customers
  choose Anthropic, OpenAI, AWS Bedrock, or Azure AI Foundry and Azure OpenAI. For Azure they
  enter the name of their resource, never an address. Needs `SECRETS_ENCRYPTION_KEY`; without
  it the feature does not exist. See `docs/DESIGN-AI-KEYS.md`.
- An owner can test the stored key from the settings page at any time. The page says whether
  the provider accepts it, or the status the provider answered with.
- The API image is published to GitHub's container registry: the version and `latest` for a
  release, `edge` for `main`. With `deploy/compose.image.yaml` the example stack pulls an image
  named in `PR_BUDDY_IMAGE` and does not build, which lets it run on a machine with 1 GB of
  memory. Building on the machine still works and is unchanged.
- Sign-in now records which installations a person owns: their own account, or an organisation
  where GitHub reports their role as `admin`.

### Upgrade notes

- People signed in before this version must sign in again before they are recognised as owners.
- Keep `SECRETS_ENCRYPTION_KEY` safe once keys are stored: without it they cannot be decrypted
  and must be entered again. To change it, set the old value as
  `SECRETS_ENCRYPTION_KEY_PREVIOUS`.

### Changed

- Dependabot no longer proposes a new major version of PostgreSQL for the Compose files: such an
  upgrade needs a dump and a restore. Upgrade guidance belongs in the deployment guide when the
  project moves to a new major.

### Verified, and not

Verified on a public deployment (one 1 GB server, the example stack, a published image pulled
by digest): a certificate from Let's Encrypt and the security headers; sign-in over HTTPS; a
review started by a webhook delivered straight from GitHub; an installation's Bedrock key saved
on the dashboard, tested, and used by that review while the server had no provider of its own;
a backup restored into a scratch database with matching row counts; an upgrade from one
published image to the next, healthy again in 12 seconds with its data intact.

Verified against a real provider with a made-up key: saving refuses it and stores nothing, and
"Test key" reports the provider's `401`.

Not verified:

- Azure against a real Azure resource. The address and the `api-key` header follow Microsoft's
  documentation and nothing has confirmed them live.
- The owner check for an organisation. Every installation so far is on a personal account. If
  GitHub refuses the membership lookup, nobody is treated as an owner there: the safe failure,
  but the feature would be unusable for that organisation.
- Anthropic and OpenAI keys that work, as an installation's key. Only Bedrock has been used.
- Uninstalling or suspending the app on the public deployment.
- More than one installation on one deployment at the same time.

Known limits: the published image is for x86-64, is not signed and has no provenance
attestation; `edge` is published before its commit's checks finish; backups are a command, not
a schedule.

## [0.1.0] — 2026-10-10

The first release. PR Buddy is a GitHub App that reviews pull requests with deterministic rules,
keeps one summary comment on each pull request up to date, and never merges or changes code.

### Added

**Review engine** (`@pr-buddy/review-engine`)

- A pure engine that takes a pull request's metadata and diff and returns findings. Each rule
  runs isolated with a time limit; every finding is validated and its file and line are checked
  against the diff.
- Seven rules: `pr-description`, `max-changed-files`, `max-changed-lines`,
  `missing-test-changes`, `debug-statements`, `credential-files`, `sensitive-file-changes`.
- Per-rule settings, and reporting thresholds for minimum severity and confidence.
- An own glob matcher with bounded cost on hostile patterns.

**GitHub App** (`@pr-buddy/github-client`, `@pr-buddy/api`)

- A webhook endpoint that verifies signatures, ignores repeated deliveries and treats the payload
  only as a trigger: what is reviewed is fetched from the API.
- One summary comment per pull request, created or updated, and comments on the lines that
  findings point at, reconciled so that a new review does not repeat them.
- Repository configuration in `.github/pr-buddy.json`, read from the base branch.
- A queue that runs one review per pull request at a time and merges bursts of pushes.

**Storage**

- Optional PostgreSQL storage for review history and webhook deliveries, with migrations applied
  at start-up. No pull request titles, descriptions, diffs or source code are stored.
- Requested reviews are remembered until they finish and are run again after a restart.
- Reviews are deleted after 365 days by default (`REVIEW_RETENTION_DAYS`).
- Uninstalling the app deletes that installation's history and sessions.

**AI review** (`@pr-buddy/ai-reviewer`), optional and off by default

- Providers: AWS Bedrock, Anthropic, OpenAI, Azure AI Foundry and any OpenAI-compatible service,
  each a small adapter with no vendor SDK.
- Needs a provider from the operator and `"ai": { "enabled": true }` from the repository.
- Suggestions are checked against the diff, shown apart from rule findings, labelled as
  unverified, and their text is not stored.

**Dashboard** (`@pr-buddy/web`), optional

- Sign-in with GitHub. A person sees the repositories of the installations GitHub lists for them.
- Overview, repositories, review history with an outcome filter, review detail and settings, in
  a dark and a light theme. Read-only.

**Operations**

- A production image that runs unprivileged on a read-only file system.
- An example deployment behind HTTPS (`deploy/`) and a deployment guide.
- Start-up validation of every setting, with warnings for risky combinations.
- GitHub Actions and container images pinned to commits and digests, enforced in CI.

### Verified, and not

Verified against real services: the GitHub App on a private test repository (comments, line
comments, configuration, storage, recovery after a kill); sign-in on `http://localhost`; AI
review through AWS Bedrock with a Bedrock API key.

Not verified against real services, and covered by automated tests only:

- A deployment on a public domain: a publicly trusted certificate, sign-in through an HTTPS
  callback, a webhook delivered by GitHub to the deployed stack, and an upgrade between releases.
  The example stack was run on `https://localhost` with a local certificate.
- The Anthropic, OpenAI, Azure and OpenAI-compatible providers, and Bedrock with a signed access
  key.
- Uninstalling or suspending the app, and removing a repository from an installation.
- Deleting reviews by age on a database that holds old reviews.
- How well the AI instructions resist a pull request that tries to instruct the model.
- Keyboard and screen-reader use of the dashboard beyond what the component tests assert.

### Known limits

- One instance. Requested reviews survive a restart, but two instances do not share work.
- No check run: PR Buddy comments but sets no pass or fail status.
- The dashboard shows what is stored: no pull request titles, authors or diffs, and no way to
  re-run a review or edit rules from it.
- Dashboard access is read at sign-in. Leaving an organisation takes effect when the session
  ends, at most eight hours later.
- `debug-statements` covers JavaScript and TypeScript only. `credential-files` checks file
  names; it is not a secret scanner.
- AWS credentials for Bedrock come from the environment only.

### Upgrade notes

None: this is the first release. From this version on, reviews older than
`REVIEW_RETENTION_DAYS` (365 unless set) are deleted at start-up and daily.

[0.3.0]: https://github.com/Abhishek-Sidnal/pr-buddy/releases/tag/v0.3.0
[0.2.0]: https://github.com/Abhishek-Sidnal/pr-buddy/releases/tag/v0.2.0
[0.1.0]: https://github.com/Abhishek-Sidnal/pr-buddy/releases/tag/v0.1.0
