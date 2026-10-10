# @pr-buddy/api

The HTTP service of [PR Buddy](../../README.md). It receives GitHub webhooks, reviews the pull
request they point at, and keeps one summary comment on that pull request up to date.

| Endpoint                | Purpose                      |
| ----------------------- | ---------------------------- |
| `POST /webhooks/github` | Receives GitHub App webhooks |
| `GET /healthz`          | Liveness check               |

- Setup, from registering the GitHub App to the first review: [docs/GITHUB_APP.md](../../docs/GITHUB_APP.md)
- Behaviour, configuration variables and permissions: [docs/DESIGN-GITHUB.md](../../docs/DESIGN-GITHUB.md)
- Threats and controls: [docs/SECURITY.md](../../docs/SECURITY.md)

## Layout

```
src/
├── main.ts                 Entry point: reads the environment and starts the server
├── app.ts                  Builds the Express application
├── logger.ts               Structured logging
├── config/env.ts           Environment variables, validated at start-up
└── modules/
    ├── github/
    │   ├── webhook.router.ts    The webhook endpoint
    │   └── delivery-store.ts    Remembers deliveries already handled
    └── reviews/
        ├── review-queue.ts      One review at a time per pull request
        └── review.service.ts    Fetch, review, publish
tests/
├── unit/                   Each module on its own
├── integration/            The whole application over HTTP, with GitHub replaced by a fake
└── helpers/                The in-memory GitHub and a recording logger
```

## Running

```bash
docker compose --profile app up --build api
```

The service needs the variables in [`.env.example`](../../.env.example). It keeps no state on
disk and runs with a read-only file system as an unprivileged user.
