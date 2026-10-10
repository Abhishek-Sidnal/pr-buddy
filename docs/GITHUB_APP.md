# PR Buddy — Registering and Running the GitHub App

How to connect a running PR Buddy to GitHub. You do this once per deployment.

## 1. Get a public URL for local development

GitHub must be able to reach your machine. A webhook proxy forwards deliveries to localhost.

1. Open <https://smee.io> and choose **Start a new channel**. Keep the channel URL.
2. Forward the channel to the API:

```bash
npx smee-client --url https://smee.io/YOUR_CHANNEL --target http://localhost:3000/webhooks/github
```

A production deployment uses its own HTTPS address instead and does not need a proxy.

## 2. Register the app

1. On GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Fill in:

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| GitHub App name           | A unique name, for example `pr-buddy-yourname`                |
| Homepage URL              | The repository URL                                            |
| Webhook URL               | Your smee channel URL, or `https://your-host/webhooks/github` |
| Webhook secret            | A long random string; see below                               |
| Where can it be installed | Only on this account, while testing                           |

Generate a webhook secret:

```bash
docker compose run --rm dev node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

3. Set **Repository permissions**:

| Permission    | Access                                           |
| ------------- | ------------------------------------------------ |
| Metadata      | Read-only (selected automatically)               |
| Pull requests | Read and write                                   |
| Single file   | Read-only, with the path `.github/pr-buddy.json` |

Leave every other permission at **No access**.

If reviews later fail with `403` while reading the configuration file, the single-file permission
is not behaving as documented. Tell the maintainers, and as a workaround grant **Contents:
Read-only** instead. Be aware that this lets the app read all code in the repository.

4. Under **Subscribe to events**, tick **Pull request** only.
5. Create the app. Note the **App ID** shown at the top of its page.
6. Under **Private keys**, choose **Generate a private key**. A `.pem` file is downloaded. Treat
   it like a password: it lets its holder act as the app.

## 3. Configure the API

Copy `.env.example` to `.env` and fill in the three required values. `.env` is ignored by git.

The private key must be on one line, with `\n` in place of each line break. This prints it in
that form:

```bash
docker compose run --rm -v "/path/to/your-key.pem:/key.pem:ro" dev node -e "console.log(require('node:fs').readFileSync('/key.pem','utf8').trim().split('\n').join('\\n'))"
```

Never commit `.env` or the `.pem` file, and never paste the key into an issue or a chat.

## 4. Run the API

```bash
docker compose --profile app up --build api
```

Check that it is up:

```bash
curl http://localhost:3000/healthz
```

## 5. Install the app and try it

1. On the app's page choose **Install App** and select one test repository.
2. In that repository, open a pull request with an empty description that changes a `.ts` file
   and no test file.
3. Within a few seconds PR Buddy comments with two findings.
4. Edit the description to explain the change. The same comment is updated; a second comment is
   not created.

If nothing happens, open the app's **Advanced** tab. It lists recent deliveries with the response
PR Buddy gave, and lets you redeliver one.

## 6. Configure a repository

Optional. Add `.github/pr-buddy.json` to the repository's default branch:

```json
{
  "rules": {
    "max-changed-files": { "options": { "maxFiles": 20 } },
    "missing-test-changes": { "enabled": false }
  }
}
```

The file is read from the pull request's base commit, so a change to it takes effect for pull
requests opened or updated after it is merged. The options are described in [RULES.md](RULES.md).

## 7. Troubleshooting

| Symptom                                       | Likely cause                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Deliveries show `401`                         | The webhook secret in GitHub and in `.env` differ                                                  |
| Deliveries show `202` but no comment          | See the API log; often the app is not installed on that repository, or the pull request is a draft |
| The log shows an authentication error         | Wrong `GITHUB_APP_ID`, or the private key lost its line breaks                                     |
| The comment says the configuration is invalid | `.github/pr-buddy.json` on the base branch has a mistake; the comment names the field              |
| Deliveries show `429` or `503`                | Rate limit or full queue; redeliver later                                                          |
