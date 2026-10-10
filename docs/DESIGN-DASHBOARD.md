# Design: the dashboard

How a person signs in and reads the review history PR Buddy has stored. Decisions are recorded in
[BRAIN.md](BRAIN.md) (D-049 to D-056); threats and controls are in [SECURITY.md](SECURITY.md).

## 1. What this part delivers

- Sign-in with GitHub.
- A read-only HTTP API over the stored history, limited to what the signed-in person may see.
- A React application, `apps/web`, served by the API from the same origin.

The dashboard reads history and changes one thing: an installation's owner can store that
installation's own AI key ([DESIGN-AI-KEYS.md](DESIGN-AI-KEYS.md)). A repository is still
configured through `.github/pr-buddy.json`.

## 2. The dashboard is optional

It is on only when all of these are set (D-053): `DATABASE_URL`, `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET` and `PUBLIC_URL`. Otherwise its routes do not exist and the service works
exactly as before. Setting some but not all of the three dashboard variables stops start-up with
a message that names what is missing.

`PUBLIC_URL` is the address people type to reach the service. It must be `https://`, except for
`http://localhost` and `http://127.0.0.1` during development.

## 3. Sign-in

PR Buddy is a GitHub App, and a GitHub App can ask a person to identify themselves. That is the
only sign-in; there are no passwords and no user table (D-049).

```
Browser                         PR Buddy                              GitHub
  │  GET /auth/login               │                                     │
  │ ─────────────────────────────► │ state = 32 random bytes             │
  │  302 + state cookie            │                                     │
  │ ◄───────────────────────────── │                                     │
  │  authorize?client_id&state&redirect_uri                              │
  │ ───────────────────────────────────────────────────────────────────► │
  │  302 /auth/callback?code&state                                       │
  │ ◄─────────────────────────────────────────────────────────────────── │
  │  GET /auth/callback            │                                     │
  │ ─────────────────────────────► │ state matches the cookie?           │
  │                                │ exchange code for a user token ───► │
  │                                │ who is this? which installations? ► │
  │                                │ forget the token; create a session  │
  │  302 / + session cookie        │                                     │
  │ ◄───────────────────────────── │                                     │
```

- **State.** A random value is put in a short-lived cookie and in the request to GitHub. The
  callback continues only if both come back equal, compared in constant time. This stops someone
  from signing a victim's browser in to the attacker's account.
- **The user token is used once.** It reads the person's ID and login and the list of
  installations of this app that they can access, and is then dropped. It is never stored, logged
  or sent to the browser (D-049).
- **What a person may see** is exactly that list of installations, as GitHub reported it at
  sign-in (D-050). GitHub includes an installation when the person can access at least one of its
  repositories.

## 4. Sessions

| Property | Value                                                                                 |
| -------- | ------------------------------------------------------------------------------------- |
| Token    | 32 random bytes, sent only in a cookie                                                |
| Stored   | The SHA-256 of the token, the person's GitHub ID and login, installation IDs, expiry  |
| Lifetime | 8 hours, fixed. No renewal: signing in again refreshes the installation list          |
| Cookie   | `HttpOnly`, `SameSite=Lax`, `Path=/`; `Secure` and the `__Host-` prefix on `https://` |
| Sign-out | `POST /auth/logout` deletes the row and clears the cookie                             |
| Cleanup  | Expired rows are deleted from time to time when a session is created                  |

Sessions live in PostgreSQL (D-051), so they survive a restart and work across instances. A
stolen copy of the table holds only hashes, which cannot be turned back into cookies.

Access is a snapshot (D-050). If a person loses access to an installation, they keep seeing its
history until their session ends, at most 8 hours later.

## 5. Read API

Every route needs a session and answers `401 {"error":"unauthenticated"}` without one. Every
query is limited to the session's installation IDs **in SQL**, so a row outside them cannot be
selected, whatever ID is asked for. Something that exists but is not visible answers `404`, the
same as something that does not exist.

| Route                                                                      | Returns                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/me`                                                              | The signed-in person's login and how many installations                  |
| `GET /api/overview`                                                        | Totals for the last 30 days and the most recent reviews                  |
| `GET /api/repositories`                                                    | Visible repositories with their latest review                            |
| `GET /api/repositories/:id/reviews`                                        | Reviews of one repository, newest first, 25 per page                     |
| `GET /api/reviews`                                                         | Reviews of every visible repository; `?status=` filters by outcome       |
| `GET /api/reviews/:id`                                                     | One review: findings, rule executions and the AI review record           |
| `GET /api/installations`; `PUT`, `DELETE` and `POST …/test` on an `ai-key` | An installation's own AI key; see [DESIGN-AI-KEYS.md](DESIGN-AI-KEYS.md) |

Paging uses a cursor made of the last row's time and ID, so a page never shifts when new reviews
arrive. IDs in paths and cursors are validated before they reach a query.

The API returns what the database holds and nothing more: no titles, descriptions, patches or AI
suggestion text exist there to return (D-031, D-046). Findings include file paths.

A review carries `newerReviewId` when a later completed review of the same pull request exists at
another commit. The dashboard uses it to mark the review as out of date (D-059).

`POST /auth/logout` is the only request that changes anything. The session cookie is
`SameSite=Lax`, so another site cannot make a browser send it with a `POST`, and the route also
rejects a request whose `Origin` header is not the dashboard's own.

## 6. The web application

`apps/web` is a React application built with Vite. The API serves its built files, so the
dashboard and its API share one origin: no CORS, and the cookie never crosses sites (D-052).

| Page         | Path                 | Shows                                                            |
| ------------ | -------------------- | ---------------------------------------------------------------- |
| Sign-in      | any, when signed out | What GitHub will share, and one button                           |
| Overview     | `/`                  | Reviews, findings and failures in 30 days; recent reviews        |
| Repositories | `/repositories`      | Each visible repository and its latest review                    |
| Repository   | `/repositories/:id`  | That repository's reviews, with paging                           |
| Review       | `/reviews/:id`       | Outcome, counts by severity, findings list and detail, AI record |
| History      | `/history`           | Every visible review, filtered by outcome through the address    |
| Settings     | `/settings`          | Theme, the session, where configuration lives, what is stored    |

- No secrets reach the browser. The application knows only what the read API returns.
- Everything from the API is rendered as text by React. Nothing is inserted as HTML.
- Links to GitHub are built from the owner, name, number and commit ID after each is checked
  against a strict pattern; a value that does not match gets no link.
- Responses carry a Content-Security-Policy that allows scripts, styles and requests from the
  dashboard's own origin only, forbids framing, and has no inline-script allowance.
- No component library and no analytics. Runtime dependencies: React, React Router, Zod and the
  bundled IBM Plex fonts (D-055). Every API answer is parsed with a Zod schema before it is shown.
- Its look, components and states follow [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md): Graphite / Signal
  Lime, light and dark themes, a sidebar that becomes a row of links on small screens.
- The theme choice is kept in the browser's local storage. Nothing else is stored in the browser.

## 7. Configuration

| Variable               | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`     | The GitHub App's client ID                                      |
| `GITHUB_CLIENT_SECRET` | A client secret generated on the app's settings page            |
| `PUBLIC_URL`           | Where the service is reached; the callback URL is built from it |

The app's settings on GitHub must list `<PUBLIC_URL>/auth/callback` as a callback URL. Setup
steps are in [GITHUB_APP.md](GITHUB_APP.md).

## 8. Testing

- Sign-in: the whole flow against a fake GitHub, including a wrong or missing state, a refused
  authorisation, a failed exchange, and canaries showing the user token is never logged or stored.
- Sessions: real PostgreSQL; expiry, sign-out, hashing, cleanup.
- Read API: two tenants in one database; every route is tried with the other tenant's IDs.
- Web: components and pages against a mocked API, including hostile text and unsafe link values.
