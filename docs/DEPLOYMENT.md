# Deploying PR Buddy

How to run PR Buddy on a server, over HTTPS, with the example stack in `deploy/`. For a first
try on your own machine, [GITHUB_APP.md](GITHUB_APP.md) is shorter.

The example is one machine running Docker Compose: Caddy for HTTPS, the API with its dashboard,
and PostgreSQL (D-063). It has no redundancy. Treat it as a correct starting point, not as the
only way.

```
Internet ──► Caddy :443 ──► API :3000 ──► PostgreSQL :5432
             (HTTPS)        (no port published)  (no port published)
```

## 1. What you need

- A machine with Docker and the Compose plugin (version 2.24 or newer). 1 GB of memory is
  enough to run the stack with a published image; building the image on the machine needs
  about 2 GB (section 3). On Ubuntu 24.04, `sudo apt-get install docker.io docker-compose-v2`
  provides both.
- A host name whose DNS points at that machine, with ports 80 and 443 reachable. Caddy uses them
  to obtain and renew a certificate. The record must point straight at the machine: with a
  proxying DNS service such as Cloudflare, set the record to "DNS only". Behind such a proxy
  Caddy may not get its certificate, and rate limits would count the proxy's address unless
  `TRUST_PROXY` is raised.
- A registered GitHub App: its ID, private key and webhook secret ([GITHUB_APP.md](GITHUB_APP.md),
  section 2).

## 2. Configure

```bash
cp deploy/.env.example deploy/.env
```

Fill in `deploy/.env`. It is ignored by git; keep it readable by you alone.

| Setting                  | Value                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `SITE_ADDRESS`           | The host name, without `https://`                                                                |
| `POSTGRES_PASSWORD`      | A password you make up. Letters and digits only, for example from `openssl rand -hex 24`         |
| `GITHUB_APP_ID`          | From the app's settings                                                                          |
| `GITHUB_PRIVATE_KEY`     | The private key on one line, with `\n` for each line break                                       |
| `GITHUB_WEBHOOK_SECRET`  | The secret you gave the app                                                                      |
| `REVIEW_RETENTION_DAYS`  | Optional. Days to keep reviews; 365 by default, `0` for ever                                     |
| `SECRETS_ENCRYPTION_KEY` | Optional. A master key that lets customers store their own AI keys; see GITHUB_APP.md, section 9 |

For the dashboard, also set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and
`PUBLIC_URL=https://<SITE_ADDRESS>`: all three, or none. For AI review, add the provider's
settings from the `.env.example` in the repository root.

Then, in the GitHub App's settings:

- **Webhook URL:** `https://<SITE_ADDRESS>/webhooks/github`. A relay such as smee.io is for
  development only and is not needed here.
- **Callback URL** (dashboard only): `https://<SITE_ADDRESS>/auth/callback`.
- **Setup URL** (dashboard only, optional): `https://<SITE_ADDRESS>/auth/login`, with
  `GITHUB_APP_SLUG` set in `deploy/.env`, so that new people can install the app from the
  dashboard and land on it afterwards ([GITHUB_APP.md](GITHUB_APP.md), section 7).

## 3. Start

There are two ways to get the API image. Both run the same stack.

**Build it on the machine.** Needs the whole repository and about 2 GB of memory:

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

**Pull a published image.** Needs only the `deploy/` folder, and far less memory. Every release
is published to GitHub's container registry by CI (D-082). Set the image in `deploy/.env`:

```
PR_BUDDY_IMAGE=ghcr.io/<owner>/pr-buddy-api@sha256:<digest>
```

Name it by digest. The digest of a release is in the summary of its "Publish image" run on
GitHub; a tag such as `:0.2.0` also works, but a tag can be moved and a digest cannot. `:edge`
follows `main` and is published before that commit's checks have finished: do not run it for
other people. Then add the second file to every command:

```bash
docker compose -f deploy/compose.yaml -f deploy/compose.image.yaml --env-file deploy/.env pull api
docker compose -f deploy/compose.yaml -f deploy/compose.image.yaml --env-file deploy/.env up -d
```

While the repository is private, so is the image. Sign the machine in once with a GitHub token
that has `read:packages` and nothing else:

```bash
docker login ghcr.io --username <your GitHub login>
```

On a machine with 1 GB of memory, add swap before the first start, so that a busy moment slows
the machine down and does not kill the database:

```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

The stack refuses to start without `SITE_ADDRESS` and `POSTGRES_PASSWORD`. On the first start
the API creates its tables.

## 4. Check

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env ps
docker compose -f deploy/compose.yaml --env-file deploy/.env logs api
```

| Check                                            | Expect                                                   |
| ------------------------------------------------ | -------------------------------------------------------- |
| `https://<SITE_ADDRESS>/healthz`                 | `{"status":"ok"}`                                        |
| `https://<SITE_ADDRESS>/readyz`                  | `{"status":"ready"}`: the database is reachable          |
| The API log at start-up                          | `Database ready`, and no line at level `warn` (level 40) |
| "Recent Deliveries" in the GitHub App's settings | A `ping` answered with `200`                             |

A warning at start-up names a combination of settings that is valid but risky, for example an
HTTPS address with `TRUST_PROXY=0`. The example stack sets `TRUST_PROXY=1` because exactly one
proxy, Caddy, is in front. If you add a load balancer in front of Caddy, raise it to 2: with the
wrong number, rate limits are applied to the wrong address.

## 5. Upgrade

If the machine builds the image:

```bash
git pull
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

If it pulls a published image, set `PR_BUDDY_IMAGE` in `deploy/.env` to the new release's
digest, update the `deploy/` folder if the release notes say it changed, and run the two
commands of section 3 again. To go back, set the previous digest and run them once more; that
returns the code, not the database (see below).

Database changes are applied by the API when it starts, in one transaction, and are never edited
after release. Back up first (section 6): there is no automatic way back to an older schema.

Reviews that are running when the API stops are given 25 seconds to finish. Any that were
requested and did not finish are run again at the next start, at most three times and within a
day of the request.

**Retention.** Reviews older than `REVIEW_RETENTION_DAYS` (default 365) are deleted at start-up
and daily. A version that introduces or shortens the limit deletes at its first start: set the
variable before upgrading if you want to keep older reviews. `0` keeps everything.

## 6. Back up and restore

Everything PR Buddy remembers is in the database: review history and sessions. It holds no
source code ([DESIGN-STORAGE.md](DESIGN-STORAGE.md)).

```bash
# Back up
docker compose -f deploy/compose.yaml --env-file deploy/.env exec -T postgres \
  pg_dump --username prbuddy --dbname prbuddy --format custom > prbuddy.dump

# Restore into a running, empty database
docker compose -f deploy/compose.yaml --env-file deploy/.env exec -T postgres \
  pg_restore --username prbuddy --dbname prbuddy --clean --if-exists < prbuddy.dump
```

Also keep `deploy/.env`: the GitHub App's private key cannot be downloaded again, only replaced.
Caddy's certificates are in the `caddy_data` volume; losing it only means they are issued again.

## 7. What is exposed

| Service  | Reachable from outside | Notes                                                          |
| -------- | ---------------------- | -------------------------------------------------------------- |
| Caddy    | Ports 80 and 443       | Port 80 only redirects to HTTPS and answers certificate checks |
| API      | No                     | Runs as an unprivileged user on a read-only file system        |
| Database | No                     | Reachable only from the API, on the stack's own network        |

The API answers on `/webhooks/github` (signed requests from GitHub only), `/healthz`, `/readyz`
and, when the dashboard is on, `/auth`, `/api` and the dashboard's pages. Browsers are told to
keep using HTTPS for a year (`Strict-Transport-Security`), so do not put the dashboard on a host
name that must also serve plain HTTP.

## 8. Trying the stack on your own machine

The same files work for `localhost`: Caddy then issues a certificate from a local authority,
which your browser will not trust until you accept it.

```
SITE_ADDRESS=localhost
PUBLIC_URL=https://localhost:8443
HTTP_PORT=8080
HTTPS_PORT=8443
```

Open `https://localhost:8443`. Sign-in also needs `https://localhost:8443/auth/callback` among
the app's callback URLs. Webhooks from GitHub cannot reach `localhost`; use the development
set-up for those.

## 9. Limits of this example

- One machine. If it is down, webhooks are missed until GitHub's deliveries are redelivered.
- One instance. Requested reviews survive a restart, but two instances would not share work.
- No metrics or alerting. The log is JSON, one object per line; collect it with whatever you use.
- Backups are a command to run, not a schedule.
- The published image is built for x86-64 only. On an Arm machine, build it there.
- The database connection is unencrypted, which is safe only because it never leaves the stack's
  private network. For a database elsewhere, change `DATABASE_URL` in `deploy/compose.yaml` and
  add `sslmode=require` or
  stronger.
