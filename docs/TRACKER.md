# PR Buddy — Tracker

Status of the work. Update this file in the same change that moves a task.

Legend: ✅ done · 🚧 in progress · ⬜ not started

## Milestones

| Milestone | Deliverable                                         | Status                  |
| --------- | --------------------------------------------------- | ----------------------- |
| M1        | Deterministic review engine                         | ✅                      |
| M2        | GitHub App integration                              | ✅                      |
| M3        | Storage, rules and thresholds, AI review, dashboard | ✅                      |
| M4        | Hardening and `v0.1.0`                              | ✅ released as `v0.1.0` |
| M5        | Hosted service: an installation's own AI key first  | 🚧 part 1 done          |

## Latest verified check

The one current figure. Counts in the sections below are what was true when each part was
accepted and are kept as history.

| Date | Command | Result |
| 2026-10-11 | `docker compose run --rm dev npm run check` | Passed: 2,282 tests (engine 474, AI reviewer 254, GitHub client 287, runner 245, API 739, web 283) |
| 2026-10-11 | `docker compose run --rm dev npm run check` | Passed: 2,239 tests (engine 474, AI reviewer 246, GitHub client 284, runner 213, API 739, web 283) |
| 2026-10-11 | `docker compose run --rm dev npm run check` | Passed: 2,204 tests (engine 474, AI reviewer 211, GitHub client 284, runner 213, API 739, web 283) |
| 2026-10-11 | `docker compose run --rm dev npm run check` | Passed: 2,094 tests (engine 474, AI reviewer 211, GitHub client 284, runner 103, API 739, web 283) |
| 2026-10-11 | `docker compose run --rm dev npm run check` | Passed: 1,938 tests (engine 474, AI reviewer 186, GitHub client 266, API 729, web 283) |
| 2026-10-11 | `docker compose run --rm dev npm run check` | Passed: 1,926 tests (engine 474, AI reviewer 186, GitHub client 266, API 717, web 283) |
| 2026-10-10 | `docker compose run --rm dev npm run check` | Passed: 1,812 tests (engine 474, AI reviewer 186, GitHub client 266, API 621, web 265) |
| 2026-10-10 | `docker compose run --rm dev npm run check` | Passed: 1,732 tests (engine 474, AI reviewer 186, GitHub client 266, API 584, web 222). The clean-checkout check for `v0.2.0` passed on `a092c81` with 1,655 |
| 2026-10-10 | `docker compose run --rm dev npm run check` | Passed: 1,655 tests (engine 474, AI reviewer 186, GitHub client 266, API 556, web 173) |
| 2026-10-10 | `docker compose run --rm dev npm run check` | Passed: 1,581 tests (engine 474, AI reviewer 186, GitHub client 266, API 504, web 151) |
| 2026-10-10 | `docker compose run --rm dev npm run check` | Passed: 1,448 tests (engine 474, AI reviewer 186, GitHub client 250, API 418, web 120) |
| 2026-10-10 | Clean export of commit `6929d67` in a fresh `node:24-alpine` container: `npm ci`, `npm run check`, audit, signatures, pin check | Passed: 1,448 tests; 0 vulnerabilities; 358 signatures verified |
| 2026-10-10 | `docker compose run --rm dev npm audit --omit=dev` | 0 vulnerabilities |

## Milestone 7 — runner mode

Design: [DESIGN-RUNNER.md](DESIGN-RUNNER.md). Decisions D-096 to D-108, accepted on 2026-10-11.
Threats R1 to R17. Phase 1 is released in `v0.4.0`; phase 2 has started (D-111 to D-117).

| Phase | Delivers                                                        | Status |
| ----- | --------------------------------------------------------------- | ------ |
| 0     | The design, the decisions, the threats                          | ✅     |
| 1     | The Action without AI: mode, gates, rules, summary, job summary | 🟡     |
| 2     | The three tools, read evidence, the tool loop, one reviewer     | 🚧     |
| 3     | Specialists and a lead; re-reviews                              | ⬜     |
| 4     | Optional reporting to a service; then usage views               | ⬜     |
| 5     | AI line comments, off by default                                | ⬜     |
| 6     | Optional notifications; a measure of findings acted on          | ⬜     |

A phase starts only when the one before it has passed its gate (DESIGN-RUNNER.md, section 18).
Phase 2 is the recorded exception: it started with two items of phase 1's gate unseen (D-111).

### Phase 0 — design and security baseline

Documents only. Reviewed and merged on 2026-10-11; the post-merge checks passed.

| Task                                                                        | Status |
| --------------------------------------------------------------------------- | ------ |
| The five decisions recorded, and the four that followed from the review     | ✅     |
| Trust boundaries, permissions per phase, fork behaviour                     | ✅     |
| Mode exclusivity on both sides, and what an invalid or unreadable file does | ✅     |
| Limits, provider compatibility, idempotency, failure modes                  | ✅     |
| Phases with acceptance gates                                                | ✅     |
| The release checks of decision 5, as found                                  | ✅     |
| Reviewed by the maintainer                                                  | ✅     |

| Check                                  | Result                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting                             | `npm run format:check` passed. There is no other check for documents                                                                                                                                                                                    |
| Cross-references                       | Checked by hand: every decision, threat and requirement named in one document exists in the others                                                                                                                                                      |
| Release checks, as found on 2026-10-11 | The repository is public. `LICENSE` holds the MIT text; GitHub's license detection reported none. `SECURITY.md` sends reports to GitHub's private reporting, which is **turned off**, so that route does not work. The code of conduct names no contact |
| Unsupported claims left in the design  | Tool calling is "documented" for each provider's API; none has been tried by PR Buddy. The limits have no numbers yet; each gets one in the phase that builds it                                                                                        |
| Still open                             | `review.mode` is not in the configuration schema yet: it arrives with phase 1, on both sides at once                                                                                                                                                    |

### Phase 1 — the Action without AI

Guide: [RUNNER.md](RUNNER.md). Decisions D-109 and D-110 were made while building it.

| Task                                                                        | Requirement      | Status |
| --------------------------------------------------------------------------- | ---------------- | ------ |
| `review.mode`, read by one function for both sides; invalid means hosted    | FR-113, NFR-113  | ✅     |
| The service skips a runner-mode repository and records why                  | FR-113           | ✅     |
| A client that acts with the workflow's token and owns only its own comments | NFR-116          | ✅     |
| Gates: closed, merged, draft, same commit; a small re-push measured         | FR-120, NFR-108  | ✅     |
| The rules, one summary comment updated in place, the reviewed commit named  | FR-112           | ✅     |
| The job summary                                                             | FR-119           | ✅     |
| Refuses `pull_request_target`; least permissions; own image pinned          | NFR-110, NFR-115 | ✅     |
| Works with no PR Buddy service                                              | NFR-114          | ✅     |
| The acceptance gate on a real repository                                    |                  | 🟡     |

Tried on a private test repository on 2026-10-11, with the Action pinned to commit `446066f`
and a workflow copied from `examples/runner-workflow.yml`. No checkout step.

| Scenario                                       | Result                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A pull request with a finding                  | Passed: one summary comment, written as GitHub Actions, with the finding and the reviewed commit                                |
| A clean pull request                           | Passed: zero findings, no comment                                                                                               |
| A draft                                        | Passed: "Nothing done: draft"                                                                                                   |
| A closed pull request                          | Passed: the run was repeated after closing; "Nothing done: closed"                                                              |
| The same commit again                          | Passed: the run was repeated; "Nothing done: same-commit"; still one comment                                                    |
| A re-push                                      | Passed: a push that added the missing test; the same comment now says "No findings" and names the new commit; still one comment |
| A base branch in hosted mode                   | Passed: "Nothing done: the base commit does not select runner mode", and the hosted service reviewed that pull request          |
| The hosted service on a runner-mode repository | Passed for the service running this change: it logged "Review skipped", reason `runner`, for each event and wrote no comment    |
| Time                                           | Each run took 34 to 39 seconds from start to finish, the image build included                                                   |

What the first real run found: GitHub builds a container action with the Dockerfile's own
folder as the build context. From `docker/` the build could not see the packages and every run
failed. The Action's Dockerfile is at the repository root for that reason.

| Not verified                                       | Why                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A pull request from a fork                         | Needs a second account's fork. The behaviour is covered by tests only                                                                                                                                                                                       |
| The job summary as GitHub shows it                 | GitHub's API does not return it. Its text is covered by tests; the page was not looked at                                                                                                                                                                   |
| A service that has not been upgraded               | Seen, and it is a hazard: the public deployment, still on the previous version, does not know `review.mode`, called the file invalid and reviewed the runner-mode pull requests as well. A service must be upgraded before a repository selects runner mode |
| The pull_request_target refusal in a real workflow | Checked in the built image and in CI, not in a workflow of that kind                                                                                                                                                                                        |
| Size limits on a very large pull request           | Covered by tests only                                                                                                                                                                                                                                       |

### Phase 2 — AI review with read-only tools

Started on 2026-10-11 on the maintainer's instruction, with the two "not verified" rows above
still open (D-111). Delivered as three changes (DESIGN-RUNNER.md, section 18).

| Task                                                                           | Change | Status |
| ------------------------------------------------------------------------------ | ------ | ------ |
| The design in numbers: the checkout, how a path is checked, every tool's limit | 2a     | ✅     |
| The checkout is opened only at the head commit, read from `.git/HEAD`          | 2a     | ✅     |
| `read_file`, `search`, `list_files`, confined to the checkout                  | 2a     | ✅     |
| The read record, and the budget for tool output                                | 2a     | ✅     |
| One never-sent policy for the prompt and the tools                             | 2a     | ✅     |
| Tool calling in each provider's adapter                                        | 2b     | ✅     |
| The tool loop: steps, tokens, time                                             | 2b     | ✅     |
| One reviewer, the filter, the Action's inputs, the comment and job summary     | 2c     | ✅     |
| Real requests to providers; a real workflow with a checkout                    | 2c     | ⬜     |

Change 2a, checked by tests against a real file system in the development container:

| Threat | What the tests try                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| R4     | `..`, absolute paths, `.git`, credential names in any capitals, lockfiles; a link to a file outside, to one inside, and through a folder |
| R5     | A text that would be a slow pattern is compared literally; each of `search`'s four limits is reached                                     |
| R12    | With a canary in the process's environment, a link to `/proc/self/environ` and `/proc/self` returns a refusal and never the canary       |
| R14    | The limits per line, per answer and per review; a line is recorded as read only if the answer that carried it fitted the review's budget |

| Not verified in 2a                              | Why                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Anything in a real workflow                     | Nothing calls the tools yet; a run behaves as in `v0.4.0`                                  |
| That `actions/checkout` leaves a commit in HEAD | Taken from its documentation. It is the first thing change 2c tries on a real repository   |
| A checkout on a file system that ignores case   | The Action runs on Linux only. Names are compared in lower case as a precaution, by a test |

Change 2b, checked by tests with a scripted provider and a fake `fetch`:

| What                    | What the tests try                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| The loop's limits (R6)  | Steps, tokens, the caller's own stop, and time, both while waiting for the provider and while a tool runs                                    |
| A hostile reply (R3)    | A tool that does not exist, more requests than are served, a request with no identifier, a reply of the wrong shape, a tool request at close |
| What is kept (D-046)    | A provider's error by name only; a failing tool's error not at all, with a canary in its message                                             |
| Each adapter's requests | The exact body sent for a conversation, for Anthropic, the Chat Completions dialects and Bedrock, and what is read back                      |

| Not verified in 2b                             | Why                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Any real provider accepting these requests** | No request was made. The bodies follow each API's documentation. This is the gate of phase 2, and change 2c makes the requests |
| That each provider accepts the closing request | The same. Its shape (tools still sent, one user turn) is a reading of the documentation, not an observation                    |
| A model's behaviour at a limit                 | No model was asked                                                                                                             |

Change 2c, checked by tests with a scripted model over a real folder:

| What                        | What the tests try                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read evidence (R7)          | A suggestion on a line of the diff, on a line a tool returned, on a line beyond what was read, in a file never opened, with a line and no file: only the read ones stay |
| A model that probes (R4)    | It asks for `.env`, `.git/config`, a path out of the checkout and a search for a secret's name: four refusals, and no canary in anything sent to it or published        |
| Every gate before cost (R6) | AI off in the repository, no provider, invalid inputs, an incomplete pull request, a small re-push, no checkout, a checkout at another commit: no provider is built     |
| An AI failure (D-048)       | The provider fails: the rules' comment is published, the run does not fail, and no error message is kept                                                                |
| The Action's inputs (R12)   | Invalid inputs are reported by name; a canary in each value never appears                                                                                               |

**The gate of phase 2 is open.** These are not verified, and none is reported as passed:

| Not verified                                           | Why, and what it needs                                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **A real request to any provider, with tools**         | No key was used. Needs a key as an Actions secret of a test repository, added by the maintainer                                              |
| Bedrock, Anthropic, OpenAI, Azure, a compatible server | Each is recorded as not tried (DESIGN-RUNNER.md, section 14) until a real request to it succeeds                                             |
| A real workflow with a checkout step                   | In particular that `actions/checkout` with a commit as `ref` leaves that commit in `.git/HEAD`, which the whole AI step depends on           |
| The Action's inputs as GitHub passes them              | The names (`INPUT_AI-API-KEY` and so on) follow GitHub's documented rule for container actions; phase 1 confirmed it for `github-token` only |
| Whether a real model's suggestions are any good        | No model was asked. The prompt is untested against one                                                                                       |
| What a real review costs in tokens and time            | The same                                                                                                                                     |

Where the ideas come from: a reviewer the maintainer built for an organisation, which runs in
CI with a full checkout. Only its design is reused. No source, prompt, rule or configuration is
taken from it.

## Milestone 6 — running it day to day

Design: [DESIGN-OPERATIONS.md](DESIGN-OPERATIONS.md), sections 5 and 6. Decisions D-092 to
D-094. Threats O11 to O14.

| Task                                                                                   | Requirement                      | Status |
| -------------------------------------------------------------------------------------- | -------------------------------- | ------ |
| The operator setting, `isOperator` in `GET /api/me`, and `GET /api/operator/overview`  | FR-109, FR-110, NFR-104, NFR-105 | ✅     |
| The operator's page                                                                    | FR-109, FR-110                   | ✅     |
| `register-app`: a GitHub App from a manifest, written to the environment file          | FR-111, NFR-106                  | ✅     |
| A development app registered with it, and a review through it on a developer's machine | FR-111                           | ✅     |

| Check                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register-app`, live                      | Passed on 2026-10-11 at the third attempt. First GitHub refused the manifest: "Single file name path is required", which showed that it takes `single_file_name` although its documentation does not list it. Then the dev container's user could not read `.env`, which was noticed only after GitHub had created the app; the command now checks first. Then it registered a private app and wrote its credentials without showing them |
| What GitHub created                       | Asked of GitHub as the new app: permissions `members: read`, `metadata: read`, `pull_requests: write`, `single_file: read`; the event `pull_request`; the single file path `.github/pr-buddy.json`. No manual step was needed                                                                                                                                                                                                             |
| A review through the development app      | Passed: a pull request in the test repository reached the developer's machine through the relay, the review read the repository's configuration, ran the rules and the AI review, and created its comment                                                                                                                                                                                                                                 |
| Two PR Buddy apps on one repository       | Observed, because the production app was still installed there: each app reviewed and each posted its own comment. Neither touched the other's                                                                                                                                                                                                                                                                                            |
| The Service page on the public deployment | Reported by the maintainer on 2026-10-11 as working after signing in as the listed operator. Seen from outside: the route answers `401` without a session, and the service logged that the operator view is on. What the page showed was not observed                                                                                                                                                                                     |

### What 0.3.0 left unverified, and what has been seen since

| Check                                                       | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An alert reaching a person                                  | Passed on 2026-10-11: after the maintainer confirmed the subscription, a rehearsed problem and its recovery each arrived by email                                                                                                                                                                                                                                                                                                                                       |
| A scheduled backup overnight                                | Passed: cron ran `deploy/backup.sh` at 20:15 UTC on 2026-10-10 and the server logged the dump as stored locally and in the bucket                                                                                                                                                                                                                                                                                                                                       |
| An alarm outside the server                                 | In place: a Lightsail alarm on the instance's status check, with a verified email contact. Not triggered: that would mean breaking the server                                                                                                                                                                                                                                                                                                                           |
| The owner check for an organisation                         | **Failed on 2026-10-11**, then diagnosed: an owner of a new organisation signed in and was not recognised. GitHub answered the membership request `403` because the app lacked the organisation permission "Members: read" (D-095). After the permission was added to the app and approved for the organisation, the same person signed in again and was recognised as its owner, with no warning logged. Seen on a development machine connected to the production app |
| A review for a second installation on the public deployment | ⬜                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Suspending the app ends sessions                            | Passed on 2026-10-11 on the public deployment: GitHub's event arrived for the organisation's installation, the one session that held it was deleted, and the maintainer's own account, its history and its key were untouched                                                                                                                                                                                                                                           |
| Uninstalling deletes history, key and sessions              | Partly: the event arrived and was handled, and nothing of that installation remains. But the organisation had no review, no key and, after the suspension, no session, so nothing was there to delete. ⬜ Repeat with an installation that has all three                                                                                                                                                                                                                |

## Milestone 5 — a hosted service

| Part | Contents                       | Status |
| ---- | ------------------------------ | ------ |
| 1    | An installation's own AI key   | ✅     |
| 2    | A first public deployment      | ✅     |
| 3    | Onboarding                     | ✅     |
| 4    | Operations: backups and alerts | ✅     |
| 5    | Who runs the service           | ✅     |
| 6    | A fair share of the queue      | ✅     |

### Parts 4 to 6 — operations, the operator's page, the queue

Design: [DESIGN-OPERATIONS.md](DESIGN-OPERATIONS.md). Decisions D-086 to D-091. Threats O1 to
O10.

| Task                                                                      | Requirement             | Status |
| ------------------------------------------------------------------------- | ----------------------- | ------ |
| A fair queue between installations, with a cap per installation           | FR-107, FR-108, NFR-103 | ✅     |
| Operator settings, the start-up warning and `GET /auth/service`           | FR-105, FR-106, NFR-102 | ✅     |
| The `/privacy` page and the links to it                                   | FR-104 to FR-106        | ✅     |
| `deploy/backup.sh`: dump, check, upload, prune, alert on failure          | FR-101, NFR-99, NFR-100 | ✅     |
| `deploy/watch.sh`: six checks, alert on change                            | FR-102, FR-103, NFR-101 | ✅     |
| On the public deployment: bucket, write-only credential, schedule, alerts | FR-101, FR-102          | ✅     |
| A restore from the bucket                                                 | NFR-100                 | ✅     |

The public deployment: a private S3 bucket in Mumbai with versioning and a 30-day expiry, an
IAM user that may only write to it and publish to one SNS topic, and both scripts in cron.

| Check                         | Result                                                                                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup, live                  | Passed on 2026-10-10: `deploy/backup.sh` dumped, listed the dump, and copied it to the bucket, encrypted at rest                                                                                                                                                                                    |
| The server's credential, live | Passed: reading a backup, listing the bucket and deleting a backup each answered `403`; only writing worked                                                                                                                                                                                         |
| Restore from the bucket, live | Passed: the object was downloaded with the operator's credential and restored into a scratch database on another machine; the counts of reviews, findings, keys, audit events and migrations matched the server, and the stored key was ciphertext                                                  |
| Alert on change, live         | Passed as a rehearsal with `WATCH_URL` pointed at an address that does not answer `200`: one message when it failed, none on the next run, one when it recovered, none after. SNS counted two messages published                                                                                    |
| A real failure, live          | Seen by accident: the first backup run failed to upload because the stored secret carried a carriage return; the script exited 1, kept the dump locally and said why                                                                                                                                |
| Schedule                      | Installed with `crontab deploy/crontab.example` on the server                                                                                                                                                                                                                                       |
| Privacy page, live            | Passed in the built image on `http://localhost:3000`, signed out: seven sections, the retention of 365 days from the service, and "has not published who they are" with no operator set; no layout overflow and no policy violation                                                                 |
| Not done                      | Nobody is subscribed to the alert topic yet, so no alert has reached a person. No alarm outside the server yet. The operator's name and contact are not set on the public deployment. A scheduled run has not been observed overnight. Fairness of the queue under real load from two installations |
| —                             | Later parts are not planned yet                                                                                                                                                                                                                                                                     | ✅  |

### Part 3 — onboarding

Design: [DESIGN-DASHBOARD.md](DESIGN-DASHBOARD.md), section 8. Decisions D-083 to D-085.

| Task                                                              | Requirement   | Status |
| ----------------------------------------------------------------- | ------------- | ------ |
| `GITHUB_APP_SLUG`, a start-up warning, and `GET /auth/service`    | FR-98, NFR-98 | ✅     |
| The page a signed-out visitor sees                                | FR-97, FR-98  | ✅     |
| "Getting started" on the overview, from stored state              | FR-100        | ✅     |
| The Install button in the notice for someone with no installation | FR-98, NFR-97 | ✅     |
| The Setup URL in the guide, and on the public deployment          | FR-99         | ✅     |

| Check                    | Result                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The visitor's page, live | Passed in the built image on `http://localhost:3000`: signed out, the page showed the Install button linking to the app's installation page on GitHub, sign-in as the second action, no layout overflow and no policy violation |
| Getting started, live    | Passed with a session created by hand for an installation without reviews: "Install the app" was done, "Get a first review" was next, and the AI step was optional with a link to the settings                                  |
| Not done                 | The Setup URL on GitHub and the journey of a second person: install from the page, come back signed in. The public deployment still runs `0.2.0`, which does not have this page                                                 |

### Part 2 — a first public deployment

Target: one small server (AWS Lightsail, 1 GB) with a domain, running the example stack from a
published image. Decision D-082.

| Task                                                            | Status |
| --------------------------------------------------------------- | ------ |
| CI publishes the API image; the stack can pull it and not build | ✅     |
| A server with Docker, swap and the stack running                | ✅     |
| The GitHub App's webhook and callback point at the domain       | ✅     |
| HTTPS sign-in, a review from a real webhook, backup and restore | ✅     |
| An upgrade from one published image to the next                 | ✅     |

The deployment: AWS Lightsail in Mumbai, 1 GB of memory with 1 GB of swap, Ubuntu 24.04, Docker
29.1 with Compose 2.40 from Ubuntu's packages, `https://prbuddy.apsidnal.in`.

| Check                    | Result                                                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scripts                  | Passed: `scripts/image-tags.test.sh`; `scripts/check-pins.sh` accepts the operator-named image and still refuses a tag given as a default                                                                                              |
| Compose                  | Passed with `docker compose config`: with the second file the API uses the named image and has no build; without it the stack builds as before; no image named, no start                                                               |
| Publishing, live         | Passed on 2026-10-10: the first run, for the merge to `main`, built and pushed `edge`                                                                                                                                                  |
| Pull on the server       | Passed: after `docker login` with a `read:packages` token the server pulled the private image by digest and started it without building                                                                                                |
| HTTPS, live              | Passed: Caddy obtained a Let's Encrypt certificate; `/healthz` answered `200` over it; HTTP redirected with `308`; the HSTS and Content-Security-Policy headers were present                                                           |
| Memory                   | With the stack running, about 430 MB of 909 MB available and 7 MB of swap used                                                                                                                                                         |
| Sign-in over HTTPS, live | Passed: the maintainer signed in on the public address; one session was stored                                                                                                                                                         |
| Installation key, live   | Passed: a Bedrock key was saved on the public dashboard and "Test key" answered `working`                                                                                                                                              |
| Webhook, live            | Passed: reopening a pull request reached the server directly from GitHub, without a relay; the review completed and updated the comment, with 5 AI suggestions from the installation's own key (the server has no provider of its own) |
| Backup and restore, live | Passed: `pg_dump` on the server, restored into a scratch database; row counts of reviews, findings, keys, audit events, sessions and migrations matched, and the scratch database was dropped                                          |
| Upgrade, live            | Passed: `PR_BUDDY_IMAGE` was changed to the next published digest, then `pull` and `up -d`; the API was healthy again 12 seconds later and the counts of reviews, keys and sessions were unchanged                                     |
| Not done                 | Uninstall and suspend events on the public address. More than one installation on the deployment. A scheduled backup kept somewhere other than the server                                                                              |

### Part 1 — an installation's own AI key

Design: [DESIGN-AI-KEYS.md](DESIGN-AI-KEYS.md). Decisions D-071 to D-081. Threats K1 to K15.

| Task                                                              | Requirement           | Status |
| ----------------------------------------------------------------- | --------------------- | ------ |
| Owner check at sign-in: own account, or organisation role `admin` | FR-92                 | ✅     |
| Encryption with a master key, bound to the row, with rotation     | NFR-90                | ✅     |
| Key store, summaries without the key, audit of every change       | FR-90, NFR-91, NFR-93 | ✅     |
| Save and remove routes behind three locks                         | NFR-92                | ✅     |
| A key is checked with the provider before it is stored            | FR-94                 | ✅     |
| Anthropic, OpenAI and Bedrock only; no address                    | FR-95                 | ✅     |
| Azure by resource name; the service builds the address            | FR-95                 | ✅     |
| An owner can test the stored key                                  | FR-96                 | ✅     |
| Reviews use the installation's key and never fall back            | FR-91, NFR-94         | ✅     |
| Uninstalling deletes the key                                      | NFR-95                | ✅     |
| Settings section for owners and for members                       | FR-93                 | ✅     |
| Absent without `SECRETS_ENCRYPTION_KEY`                           | NFR-96                | ✅     |

| Check                         | Result                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations `0006`, `0007`     | Applied at start-up on the running database                                                                                                                                                                                                                                                    |
| Locks, live                   | Passed on the running service with sessions created by hand: a write without the `Origin`, with another site's `Origin`, or without the custom header answered `403`                                                                                                                           |
| Roles, live                   | Passed: a member's write answered `403`; a write to an installation outside the session answered `404`                                                                                                                                                                                         |
| Check with the provider, live | Passed against the real Anthropic API with a made-up key: the provider answered `401`, the service answered `422` and stored nothing; the log named the status and not the key                                                                                                                 |
| Settings page, live           | Passed in the built image: the section lists the installation, offers the four providers and a password field, with no layout overflow and no policy violation                                                                                                                                 |
| Test key, live                | Passed: a made-up key stored for a temporary installation was tested through the page; the real Anthropic API answered `401` and the page said the key is not working. Without the custom header, or with another site's `Origin`, the route answered `403`; with no key it answered `missing` |
| Azure input, live             | Passed: a resource name holding an address, a missing name and a `baseUrl` field each answered `400` and no request left the service; a well-formed name of a resource that does not exist answered `502` and stored nothing                                                                   |
| Not done                      | A real key saved through the page and used by a review: it must be typed by the maintainer. The organisation owner check against a real organisation: the test installation is on a personal account. An Azure key against a real Azure resource: there is no Azure account to test with       |

## Milestone 4 — hardening and `v0.1.0`

| Part | Contents                                                                    | Status |
| ---- | --------------------------------------------------------------------------- | ------ |
| 1    | Deployment behind HTTPS: example stack, guide, start-up checks              | ✅     |
| 2    | Data lifecycle and recovery: pending reviews, retention, uninstall clean-up | ✅     |
| 3    | Supply chain: actions and base images pinned to digests                     | ✅     |
| 4    | Release `v0.1.0`: changelog, procedure, clean-checkout check, tag           | ✅     |

### Part 1 — deployment behind HTTPS

Guide: [DEPLOYMENT.md](DEPLOYMENT.md). Decisions D-063 to D-065.

| Task                                                        | Requirement   | Status |
| ----------------------------------------------------------- | ------------- | ------ |
| Example stack: Caddy, API, PostgreSQL                       | FR-80, NFR-81 | ✅     |
| No default database password                                | NFR-82        | ✅     |
| Deployment guide: configure, start, check, upgrade, back up | FR-81         | ✅     |
| Start-up warnings for risky combinations of settings        | FR-82         | ✅     |
| `Strict-Transport-Security` over an HTTPS address           | NFR-80        | ✅     |

| Check                          | Result                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Example stack on `localhost`   | Passed over HTTPS with Caddy's local certificate: health and readiness `200`; HTTP redirected; HSTS and the Content-Security-Policy present; only the proxy published a port                       |
| Cookies and sign-in redirect   | Passed: the state cookie is `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`; the redirect to GitHub carries the HTTPS callback address                                                             |
| Webhook endpoint through proxy | Passed: unsigned request `401`; a 3 MB body refused with `413`                                                                                                                                     |
| Rate limit behind the proxy    | Passed: 33 sign-in requests with a different forged `X-Forwarded-For` each still hit the limit of 30                                                                                               |
| Fresh database                 | Passed: all four migrations applied on first start                                                                                                                                                 |
| Backup and restore commands    | Passed: a dump of the development database restored into a scratch database with the same row counts                                                                                               |
| Not done                       | A real domain with a public certificate; sign-in completed over HTTPS (needs the HTTPS callback URL added to the app); a webhook delivered by GitHub to the stack; an upgrade between two releases |

### Part 2 — data lifecycle and recovery

Design: [DESIGN-STORAGE.md](DESIGN-STORAGE.md) sections 10 to 12. Decisions D-066 to D-069. It
also answers the external review of Milestone 3 (2026-10-10):

| Review item                                                  | Outcome                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| P1: queued reviews are lost on restart                       | ✅ Requests are stored and recovered at start-up (D-066, D-067). At-least-once, one instance |
| P1: no retention limit                                       | ✅ 365 days by default, configurable, `0` keeps everything (D-068)                           |
| P1: AI providers not all validated live                      | Open. Only Bedrock with an API key has run live; the rest need the maintainer's keys         |
| P2: tracker marks M3 done but backlog says M3                | ✅ Backlog relabelled; see the note above it                                                 |
| Second review: M4 table still showed part 2 as not started   | ✅ Corrected. The edit that should have set it missed the line                               |
| Second review: recovery after a kill during an active review | ✅ Staged live, with the retry limit; see the checks below                                   |
| P2: stale test counts                                        | ✅ One "Latest verified check" section; older counts are labelled as history                 |
| Reproduce the checks from a clean checkout                   | ✅ Done for the release; see part 4                                                          |

| Task                                                            | Requirement   | Status |
| --------------------------------------------------------------- | ------------- | ------ |
| `pending_reviews`: remember a request until its review finishes | FR-83         | ✅     |
| Recovery at start-up, at most three attempts within a day       | FR-83, NFR-84 | ✅     |
| Retention job at start-up and daily, in batches                 | FR-84, NFR-86 | ✅     |
| Uninstall deletes the installation's history and sessions       | FR-85         | ✅     |
| Suspension and repository removal end access at once            | FR-86         | ✅     |
| All of it optional without a database                           | NFR-85        | ✅     |

| Check               | Result                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recovery, live      | Passed: a pending request for `pr-buddy-test#4` was written to the database, the API restarted, and the log showed it recovered and the review completed; the row was gone afterwards                                                                                                                                                                       |
| Migration `0005`    | Applied at start-up on the running database                                                                                                                                                                                                                                                                                                                 |
| Retention, live     | Ran at start-up and deleted nothing, as no review is older than a year. Deletion itself is covered by tests against PostgreSQL only                                                                                                                                                                                                                         |
| Installation events | Covered by tests against PostgreSQL with signed requests. Not exercised live: it would mean uninstalling the app from the test repository                                                                                                                                                                                                                   |
| A kill mid-review   | Passed on 2026-10-10: a review of `pr-buddy-test#4` was requested, its pending row confirmed, and the API process killed with SIGKILL while the review ran. After restart the log showed one review recovered and completed; the row was gone; the pull request still had exactly one summary comment, updated in place, and no line comments were repeated |
| Retry limit, live   | Passed on 2026-10-10: a request for a pull request that does not exist failed with `404` at each of three starts (attempts 1, 2, 3) and was dropped at the fourth, which recovered nothing. The service stayed healthy throughout                                                                                                                           |

### Part 3 — supply chain

Decision D-070. Controls in [SECURITY.md](SECURITY.md), section 4.

| Task                                                                    | Status |
| ----------------------------------------------------------------------- | ------ |
| GitHub Actions pinned to full commit SHAs                               | ✅     |
| Base images pinned to digests: Dockerfiles, Compose files, CI service   | ✅     |
| `scripts/check-pins.sh` in CI fails on a reference by tag alone         | ✅     |
| Dependabot covers Compose files as well as npm, Actions and Dockerfiles | ✅     |

| Check     | Result                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------- |
| Pin check | Passed on the repository; failed, as it should, on a probe workflow with `actions/checkout@v7` |
| Images    | The development and API images build from the pinned bases                                     |
| Not done  | A Dependabot pull request that moves a pin has not arrived yet, so that path is unobserved     |

### Part 4 — release `v0.1.0`

How a release is made: [RELEASING.md](RELEASING.md). Notes: [CHANGELOG.md](../CHANGELOG.md).

| Task                                                     | Status                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changelog with what is verified, what is not, and limits | ✅                                                                                                                                                                                                                                                                                  |
| Release procedure written down                           | ✅                                                                                                                                                                                                                                                                                  |
| Clean-checkout check of the committed files              | ✅ Passed on commit `6929d67`, Node.js 24.21: 236 committed files exported with `git archive` into a fresh container, `npm ci`, then 1,448 tests, audit with 0 vulnerabilities, 358 registry signatures verified, pin check. Log kept as `release-check-v0.1.0.log` for the release |
| Tag `v0.1.0` and publish the release                     | ✅ Tagged on `d7b8d6e` on 2026-10-10, after the clean-checkout check was run again on that exact commit and CI had passed on it; the log is attached to the release                                                                                                                 |

## Milestone 3, part 4 — the dashboard

Design: [DESIGN-DASHBOARD.md](DESIGN-DASHBOARD.md) and [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).
Visual direction: [ADR 0001](ADR/0001-visual-direction.md).

| Task                                                            | Requirement           | Status |
| --------------------------------------------------------------- | --------------------- | ------ |
| Requirements, design and decisions D-049 to D-059               | —                     | ✅     |
| Sign-in with GitHub, protected by a state value                 | FR-70, NFR-71, NFR-73 | ✅     |
| Sessions in PostgreSQL, stored as a hash, 8 hours               | NFR-72                | ✅     |
| Read API limited in SQL to the session's installations          | FR-71, NFR-70         | ✅     |
| Review history across repositories, filtered by outcome         | FR-73                 | ✅     |
| Web application served by the API under a strict CSP            | FR-77, NFR-76         | ✅     |
| Design system: tokens, light and dark themes, shared components | —                     | ✅     |
| Shell, overview, repositories, history, review detail, settings | FR-72 to FR-76        | ✅     |
| Out-of-date marker on a review that has been superseded         | —                     | ✅     |
| Dashboard off unless fully configured                           | NFR-75                | ✅     |
| Sign-in against real GitHub                                     | FR-70                 | ✅     |

### Acceptance

| Check                        | Result                                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check` then         | Passed: 1,279 tests (engine 474, AI reviewer 93, GitHub client 236, API 356, web 120)                                                                                                                          |
| Tenant isolation             | Passed: two tenants in one database; every route tried with the other tenant's IDs answers `404`, the same as a missing ID                                                                                     |
| Production image             | Passed: migration `0004` applied at start-up; the page is served with the Content-Security-Policy and no inline script; fonts load from the same origin                                                        |
| Browser, real stored reviews | Passed with a session row created by hand in the development database: all six routes in the dark and light themes; no console CSP errors                                                                      |
| Narrow screens               | Passed at 375 px on every route in both themes: no horizontal overflow, no text below 12 px                                                                                                                    |
| Deep links                   | Passed: `?finding=2` restores the selected finding; `?status=` restores the history filter                                                                                                                     |
| Sign-in against real GitHub  | Passed on 2026-10-10: the maintainer signed in through the app `pr-buddy-abhishek-sidnal` at `http://localhost:3000`; the log recorded the sign-in with one installation, and the session was stored as a hash |
| Keyboard and screen reader   | Checked in tests by role and accessible name; not walked through by hand with a screen reader                                                                                                                  |

Left out on purpose, with reasons, in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) section 6: the pull
request queue, titles and authors, diffs, AI suggestion text, "re-run review", editable rules and
settings.

## Milestone 3, part 3 — the AI reviewer

Design: [DESIGN-AI.md](DESIGN-AI.md). Five providers are included (AWS Bedrock, Anthropic, OpenAI,
Azure AI Foundry, any OpenAI-compatible service). Nothing is sent anywhere until the operator sets
`AI_PROVIDER` and a repository opts in.

| Task                                                              | Requirement           | Status |
| ----------------------------------------------------------------- | --------------------- | ------ |
| Requirements, design and decisions D-041 to D-048                 | —                     | ✅     |
| Package `@pr-buddy/ai-reviewer` with the `AiProvider` interface   | FR-60, FR-67          | ✅     |
| Repository switch `ai.enabled`, read at the base commit           | FR-61                 | ✅     |
| File selection, budgets and the prompt                            | FR-62, NFR-60, NFR-63 | ✅     |
| Reply parsing and verification against the files sent             | NFR-61, NFR-62        | ✅     |
| One request with a time limit, no retry                           | NFR-64                | ✅     |
| Suggestions in their own section of the comment                   | FR-63, FR-64, NFR-67  | ✅     |
| Thresholds apply to suggestions                                   | FR-65                 | ✅     |
| Failure never fails the review                                    | NFR-65                | ✅     |
| `ai_reviews` table, without suggestion text                       | FR-66, NFR-66         | ✅     |
| Providers: Bedrock, Anthropic, OpenAI, Azure, OpenAI-compatible   | FR-60, FR-68          | ✅     |
| Bedrock run against the real service, with a Bedrock API key      | FR-60                 | ✅     |
| Anthropic, OpenAI, Azure and compatible run against real services | FR-60                 | ⬜     |
| Bedrock with an access key (request signing) against real AWS     | FR-60                 | ⬜     |

### Acceptance

| Check                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`          | Passed: 1,385 tests (engine 474, AI reviewer 186, GitHub client 236, API 369, web 120)                                                                                                                                                                                                                                                                                                                                                                                           |
| AWS request signing      | Passed: reproduces the signing key and the signature AWS publishes for its example request                                                                                                                                                                                                                                                                                                                                                                                       |
| Canary tests             | Passed: prompt text, reply text and provider error messages reach neither the logs nor the stored record                                                                                                                                                                                                                                                                                                                                                                         |
| Migration `0003`         | Applied at start-up on the running database, in the read-only container                                                                                                                                                                                                                                                                                                                                                                                                          |
| Live run, no provider    | Passed: `pr-buddy-test#3` reopened and reviewed as before; no AI fields in the log, no row in `ai_reviews`, line comments not repeated                                                                                                                                                                                                                                                                                                                                           |
| Live run with a provider | Passed on 2026-10-10 with Bedrock (`us.anthropic.claude-sonnet-4-6`, `us-east-1`, a Bedrock API key) on `pr-buddy-test#4`: one request of 955 input and 517 output tokens answered in 8.6 s; five suggestions, all on lines of the diff, none rejected; published in their own section, none as line comments; the record stored without their text. Not run live: the other four providers, and Bedrock with a signed access key. Resistance to prompt injection was not probed |

## Milestone 3, part 2 — rules, thresholds and line comments

| Task                                                 | Requirement           | Status |
| ---------------------------------------------------- | --------------------- | ------ |
| Requirements and decisions D-035 to D-040            | —                     | ✅     |
| Patch parser keeps the text of added lines           | FR-58                 | ✅     |
| Rule `max-changed-lines`                             | FR-50                 | ✅     |
| Rule `debug-statements`                              | FR-51, NFR-50, NFR-54 | ✅     |
| Rule `credential-files`                              | FR-52                 | ✅     |
| Rule `sensitive-file-changes`                        | FR-53                 | ✅     |
| Reporting thresholds in the engine                   | FR-54                 | ✅     |
| Hidden-finding count in the comment and the database | FR-55                 | ✅     |
| Line comments, reconciled by fingerprint             | FR-56, FR-57, NFR-52  | ✅     |
| Line-comment failures do not fail a review           | NFR-53                | ✅     |

### Acceptance

| Check                         | Result                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`               | Passed: 894 tests (engine 469, GitHub client 208, API 217)                                                                                                                                         |
| Live run on `pr-buddy-test#3` | Passed: two debug statements pushed, two line comments appeared on the right lines; re-reviewing the same commit added none; removing one statement deleted exactly its comment and kept the other |
| Migration `0002`              | Applied at start-up on the running database                                                                                                                                                        |

Not exercised live: thresholds from a repository file, the 20-comment cap, a failed line-comment call. These are covered by automated tests only.

## Milestone 3, part 1 — storage

| Task                                                               | Requirement          | Status |
| ------------------------------------------------------------------ | -------------------- | ------ |
| Storage design, requirements, threats and decisions D-029 to D-034 | —                    | ✅     |
| Schema and first migration                                         | FR-40, FR-41         | ✅     |
| Migration runner: one transaction, advisory lock, checksums        | FR-43                | ✅     |
| Connection pool with transactions                                  | NFR-41, NFR-43       | ✅     |
| Delivery store in PostgreSQL                                       | FR-42                | ✅     |
| Review store in PostgreSQL                                         | FR-40, FR-41, NFR-40 | ✅     |
| Review service records completed, skipped and failed reviews       | FR-40, NFR-44        | ✅     |
| Service runs without a database                                    | FR-44                | ✅     |
| Readiness endpoint                                                 | FR-45                | ✅     |
| Development database in Compose; PostgreSQL service in CI          | NFR-46               | ✅     |

### Acceptance

| Check                               | Result                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                     | Passed: 734 tests (engine 358, GitHub client 178, API 198)                                                                                         |
| Storage tests against PostgreSQL 17 | Passed, including concurrent claims and concurrent migrations                                                                                      |
| Live run                            | Passed: migration applied at start-up in the read-only container; a real review of `pr-buddy-test#2` was stored with its finding and rule versions |
| Stored content                      | Verified by test: no title, description or patch reaches the database                                                                              |

### Next parts of Milestone 3

| Part                 | Contents                                          |
| -------------------- | ------------------------------------------------- |
| Rules and thresholds | Done; see part 2 above                            |
| AI reviewer          | Done except for a real provider; see part 3 above |
| Dashboard            | Done; see part 4 above                            |

## Milestone 2 — GitHub App

### Documentation

| Task                                                              | Status |
| ----------------------------------------------------------------- | ------ |
| Requirements in the PRD, GitHub App design, setup guide           | ✅     |
| Security: threats and controls for the webhook, API and container | ✅     |
| Decisions D-017 to D-022                                          | ✅     |

### GitHub client (`packages/github-client`)

| Task                                                       | Requirement   | Status |
| ---------------------------------------------------------- | ------------- | ------ |
| Webhook signature verification                             | FR-20         | ✅     |
| Pull request event parsing                                 | FR-22         | ✅     |
| `RepositoryClient` interface and Octokit implementation    | FR-24, NFR-26 | ✅     |
| Installation-scoped authentication                         | FR-24, NFR-22 | ✅     |
| Bounded retry of transient errors                          | FR-30         | ✅     |
| Mapping GitHub files to review engine input                | FR-24         | ✅     |
| Summary rendering that neutralises contributor-chosen text | FR-25, NFR-25 | ✅     |
| Publishing one comment, updated in place                   | FR-25, FR-26  | ✅     |

### API (`apps/api`)

| Task                                                            | Requirement    | Status |
| --------------------------------------------------------------- | -------------- | ------ |
| Environment configuration validated at start-up                 | NFR-23         | ✅     |
| Structured logging with redaction                               | NFR-23, NFR-24 | ✅     |
| Webhook endpoint: size limit, rate limit, signature, validation | FR-20, NFR-21  | ✅     |
| Delivery deduplication                                          | FR-21          | ✅     |
| Review queue: one per pull request, coalescing, bounded         | NFR-20, NFR-21 | ✅     |
| Review service: skip drafts and closed, stale check, publish    | FR-23, FR-27   | ✅     |
| Repository configuration from the base commit                   | FR-28, FR-29   | ✅     |
| Graceful shutdown                                               | —              | ✅     |
| Production image: unprivileged, read-only                       | —              | ✅     |

### Acceptance

Last run on 2026-10-10 with `docker compose run --rm dev npm run check` (Node.js 25).

| Check                               | Result                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Formatting, build, lint, type-check | Passed                                                                                                                         |
| Tests                               | Passed: 662 tests (engine 358, GitHub client 178, API 126)                                                                     |
| Coverage, statements                | Engine 100%, GitHub client 100%, API 98.7%                                                                                     |
| Audit                               | `npm audit`: no known vulnerabilities                                                                                          |
| Container smoke test                | Passed: health, `401` unsigned, `401` wrong secret, `202` signed, duplicate detected, unprivileged user, read-only file system |
| Real GitHub API                     | Passed; see "Live test" below                                                                                                  |

### External review, 2026-10-10

| Finding                                            | Verdict                          | Outcome                                                                                       |
| -------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| GitHub has no single-file permission               | Incorrect: the permission exists | Kept; verified in the live test (D-028)                                                       |
| No total limit on patch size                       | Valid                            | ✅ 10 million characters per review, enforced on retrieval, mapping and in the engine (D-023) |
| Malformed hunks can verify invented lines          | Valid                            | ✅ Only hunks that match their header verify locations (D-024)                                |
| Rate limits are not retried                        | Valid                            | ✅ Bounded wait and retry; failed reviews can be redelivered (D-025, D-026)                   |
| Stale result can publish between check and comment | Valid                            | ✅ Documents now state the real guarantee (D-027)                                             |

### Live test, 2026-10-10

Run against the real GitHub API with the app `pr-buddy-abhishek-sidnal` installed on the private
repository `pr-buddy-test`, webhooks relayed through smee.io to the API container.

| Scenario                                                          | Result                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Pull request opened with no description and one source file       | ✅ One comment, two findings                                    |
| Description edited                                                | ✅ Same comment updated to one finding                          |
| Commit pushed adding a test file                                  | ✅ Same comment updated to "No findings", naming the new commit |
| `.github/pr-buddy.json` on the base branch, new pull request      | ✅ Configuration applied: rule disabled, severity raised        |
| Configuration read with the single-file permission only           | ✅ Works; no Contents permission needed                         |
| Draft pull request opened                                         | ✅ Skipped, no comment                                          |
| Draft marked ready for review                                     | ✅ Reviewed, one comment                                        |
| Signature verification with the real webhook secret, through smee | ✅ All six deliveries accepted                                  |
| Warnings or errors in the API log                                 | ✅ None                                                         |

Not exercised live: redelivery, rate limits, very large pull requests, a push during a review.
These are covered by automated tests only.

## Milestone 1 — review engine

Complete. Engine, three rules, 348 tests at 100% coverage. Details are in the change log and in
[DESIGN.md](DESIGN.md).

## Open items before going public

| Item                                                              | Owner      |
| ----------------------------------------------------------------- | ---------- |
| Enable private vulnerability reporting in the repository settings | Maintainer |
| Add a contact method for code of conduct reports to the profile   | Maintainer |
| Decide the copyright holder named in `LICENSE`                    | Maintainer |
| Switch the repository from private to public                      | Maintainer |

## Backlog

Milestone 3 was accepted on its core scope: storage, rules and thresholds, the AI reviewer and
the dashboard. Items that once carried "M3" here were optional extras; they are now marked
"Later" so that the milestone table and this list agree.

| Item                                                                                                            | When                            |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Run Anthropic, OpenAI, Azure and OpenAI-compatible, and Bedrock with an access key, against their real services | M4, needs the maintainer's keys |

| A queue shared by several instances | Later |
| Check run with a pass or fail conclusion | Later |
| AWS credentials from roles, profiles or single sign-on (needs the SDK or more code) | Later |
| Line comments for AI suggestions, with a fingerprint that survives rewording | Later |
| Per-repository AI budget and usage report | Later |
| Dashboard: editing settings, roles within an installation, charts | Later |
| YAML repository configuration | Later |
| Run third-party rules in a worker thread with a hard time limit | Later |
| Browser test of the dashboard and of sign-in against real GitHub in CI | Later |

## Change log

| Date       | Change                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 2026-10-10 | Project documentation written; Milestone 1 started                                                                |
| 2026-10-10 | Review engine, three rules, tests and tooling implemented                                                         |
| 2026-10-10 | Replaced picomatch with an own glob matcher after measuring a denial-of-service risk                              |
| 2026-10-10 | Milestone 1 acceptance checks passed; repository published privately on GitHub                                    |
| 2026-10-10 | Milestone 2: GitHub client package, API service, production image, CI image build                                 |
| 2026-10-10 | Milestone 2 merged; dependency bumps merged; TypeScript 7 held back in Dependabot                                 |
| 2026-10-10 | Hardening after an external review: patch budget, stricter patch parser, rate-limit retry, redeliverable failures |
| 2026-10-10 | GitHub App registered and verified live on a test repository; Milestone 2 complete                                |
| 2026-10-10 | Milestone 3 started: PostgreSQL storage for review history and webhook deliveries                                 |
| 2026-10-10 | Four rules, reporting thresholds and reconciled line comments; verified live                                      |
| 2026-10-10 | AI reviewer package, repository switch, comment section and storage; no real provider yet                         |
| 2026-10-10 | Dashboard: sign-in with GitHub, sessions, read API, React app in the Graphite / Signal Lime design system         |
| 2026-10-10 | Dashboard sign-in verified against real GitHub                                                                    |
| 2026-10-10 | AI providers: Bedrock (with own request signing), Anthropic, OpenAI, Azure AI Foundry, OpenAI-compatible          |
| 2026-10-10 | Bedrock verified live: five suggestions on a test pull request; Milestone 3 complete                              |
| 2026-10-10 | Milestone 4 started: example HTTPS deployment, deployment guide, start-up warnings, HSTS                          |
| 2026-10-10 | Recovery of requested reviews after a restart, a retention limit, clean-up on uninstall; tracker reconciled       |
| 2026-10-10 | Actions and images pinned; changelog and release procedure written; clean-checkout check passed                   |
| 2026-10-10 | `v0.1.0` released                                                                                                 |
| 2026-10-10 | Second external review: tracker row corrected; kill during a running review and the retry limit staged live       |
| 2026-10-10 | Milestone 5 started: an installation can store its own AI key, encrypted, managed by its owners                   |
