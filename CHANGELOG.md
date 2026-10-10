# Changelog

Notable changes to PR Buddy. The format follows [Keep a Changelog](https://keepachangelog.com/),
and versions follow [Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version may
change behaviour or configuration; such changes are listed under "Upgrade notes".

## [Unreleased]

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

[0.1.0]: https://github.com/Abhishek-Sidnal/pr-buddy/releases/tag/v0.1.0
