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

## 7. Turn on the dashboard

Optional. The dashboard lets people sign in with GitHub and read the review history. It needs the
database and three more settings; design and limits are in
[DESIGN-DASHBOARD.md](DESIGN-DASHBOARD.md).

1. Open your app's settings on GitHub: **Settings → Developer settings → GitHub Apps → your app**.
2. Under **Callback URL**, add the address of the service followed by `/auth/callback`. For a
   local run that is `http://localhost:3000/auth/callback`.
3. Copy the **Client ID** shown near the top of the page.
4. Under **Client secrets**, choose **Generate a new client secret** and copy it. GitHub shows it
   once.
5. Add to `.env`:

   ```
   GITHUB_CLIENT_ID=<the client ID>
   GITHUB_CLIENT_SECRET=<the client secret>
   PUBLIC_URL=http://localhost:3000
   ```

6. Start the API again and open `PUBLIC_URL` in a browser.

`PUBLIC_URL` is the address people type, not the webhook address. It must be `https://` unless it
is `http://localhost` or `http://127.0.0.1`. Setting only some of the three stops the service at
start-up with a message that names what is missing.

A person sees the repositories of the installations GitHub lists for them, as of the moment they
signed in. Sessions last 8 hours.

## 8. Turn on AI review

Optional. With it on, PR Buddy asks a language model for suggestions and shows them apart from
the rule findings. It sends code to the service you choose, so it needs two switches: one here,
and one in each repository. Design and limits: [DESIGN-AI.md](DESIGN-AI.md).

**1. Choose a provider** and add its settings to `.env`. `AI_MODEL` is always required.

| Provider                        | Settings                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| AWS Bedrock                     | `AI_PROVIDER=bedrock`, `AI_MODEL`, `AWS_REGION`, and an access key or a Bedrock API key (below)           |
| Anthropic                       | `AI_PROVIDER=anthropic`, `AI_MODEL`, `AI_API_KEY`                                                         |
| OpenAI                          | `AI_PROVIDER=openai`, `AI_MODEL`, `AI_API_KEY`                                                            |
| Azure AI Foundry / Azure OpenAI | `AI_PROVIDER=azure`, `AI_MODEL` (the deployment name), `AI_API_KEY`, `AI_BASE_URL` ending in `/openai/v1` |
| Another compatible service      | `AI_PROVIDER=openai-compatible`, `AI_MODEL`, `AI_BASE_URL`, and `AI_API_KEY` if the service wants one     |

For Bedrock:

1. In the AWS console, open **Amazon Bedrock** in the region you will use and make sure your
   account has access to the model. Note the model ID or inference profile ID, for example one
   that starts with `us.`.
2. Create credentials that may call that model and nothing else. Either a **Bedrock API key**
   (Bedrock → API keys), set as `AWS_BEARER_TOKEN_BEDROCK`, or an **IAM access key** whose policy
   allows `bedrock:InvokeModel` on that model, set as `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY` (plus `AWS_SESSION_TOKEN` for temporary credentials).
3. Add to `.env`:

   ```
   AI_PROVIDER=bedrock
   AI_MODEL=<model or inference profile ID>
   AWS_REGION=<region, for example us-east-1>
   AWS_BEARER_TOKEN_BEDROCK=<key>
   ```

**2. Restart the API.** The log says `AI review is available` with the provider and model. A
setting that does not fit stops the service and names the variable.

**3. Opt a repository in.** On its default branch, in `.github/pr-buddy.json`:

```json
{
  "ai": { "enabled": true }
}
```

The file is read from the pull request's base branch, so this takes effect for pull requests
opened or updated after it is merged.

**4. Open or update a pull request there.** PR Buddy's comment gains an "AI suggestions" section
when the model has something to say. If the call fails, the comment says the AI review could not
be completed, and the API log has a line `AI review failed` with an error such as
`ProviderHttp403`.

## 9. Let installations use their own AI key

Optional, and meant for a PR Buddy that serves other people. It lets the owners of an
installation store their own AI provider and key on the dashboard, so their reviews go to a
provider they chose and pay for. Design: [DESIGN-AI-KEYS.md](DESIGN-AI-KEYS.md).

1. Turn the dashboard on (section 7).
2. Create a master key and add it to `.env`:

   ```bash
   openssl rand -base64 32
   ```

   ```
   SECRETS_ENCRYPTION_KEY=<the output>
   ```

3. Restart the API. The log says `Installations may store their own AI keys`.
4. Sign in again. On **Settings**, the section **AI review key** lists each installation. An
   owner of the account sees a form; everyone else sees what is set.

Keep the master key safe and backed up: stored keys cannot be read without it. To replace it,
set the new value as `SECRETS_ENCRYPTION_KEY` and the old one as
`SECRETS_ENCRYPTION_KEY_PREVIOUS`; a key is re-encrypted when its owner saves it again.

An installation's own key is used in place of `AI_PROVIDER` for that installation's
repositories, and `AI_PROVIDER` may be left unset. A repository still has to opt in with
`"ai": { "enabled": true }`.

Who counts as an owner: on a personal account, that person; on an organisation, a member whose
role GitHub reports as `admin`. The role is read at sign-in.

What an owner enters:

| Provider                        | Fields                                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| Anthropic, OpenAI               | Model, API key                                                     |
| AWS Bedrock                     | Model or inference profile ID, region, Bedrock API key             |
| Azure AI Foundry / Azure OpenAI | Deployment name, resource name, API key. The name, not the address |

For Azure, the resource name is the part before `.openai.azure.com` in the resource's endpoint.
PR Buddy builds the address from it; an owner cannot enter one.

Once a key is saved, **Test key** asks the provider once with the stored key and shows whether
it still works. Use it after rotating a key, or when the comment on a pull request says the AI
review could not be completed. Each test is one very small request on the owner's key.

## 10. Troubleshooting

| Symptom                                         | Likely cause                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Deliveries show `401`                           | The webhook secret in GitHub and in `.env` differ                                                  |
| Deliveries show `202` but no comment            | See the API log; often the app is not installed on that repository, or the pull request is a draft |
| The log shows an authentication error           | Wrong `GITHUB_APP_ID`, or the private key lost its line breaks                                     |
| The comment says the configuration is invalid   | `.github/pr-buddy.json` on the base branch has a mistake; the comment names the field              |
| Deliveries show `429` or `503`                  | Rate limit or full queue; redeliver later                                                          |
| The dashboard address answers `404`             | The dashboard is off: the log says so at start-up. Set the database and all three settings         |
| Sign-in returns with "did not complete"         | The callback URL in the app's settings does not match `PUBLIC_URL`, or the client secret is wrong  |
| Signed in, but no repositories                  | The app is not installed where you have access, or nothing has been reviewed since storage was on  |
| AI review fails with `ProviderHttp401` or `403` | The key is wrong or expired, or it may not call that model in that region                          |
| AI review fails with `ProviderHttp404`          | The model ID, deployment name or base URL is wrong                                                 |
| AI review fails with `ProviderHttp429`          | The provider is rate limiting; the next push tries again                                           |
| No "AI suggestions" section                     | The repository has not opted in on its base branch, or the model found nothing worth reporting     |
| No "AI review key" section on Settings          | `SECRETS_ENCRYPTION_KEY` is not set, or the dashboard is off                                       |
| The section shows no form                       | You are not an owner of that account, or you signed in before the feature was on: sign in again    |
| Saving a key says the provider refused it       | The key is wrong, or may not use that model or region; the status is shown                         |
| An Azure key is refused with HTTP 404           | The deployment name or the resource name is wrong; the model's own name is not the deployment name |
| Test key says the key is not working            | It expired, was revoked, ran out of credit or lost access to the model: replace it                 |
