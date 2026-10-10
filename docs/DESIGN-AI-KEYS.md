# Design: an installation's own AI key

How an organisation or person that installed PR Buddy can supply their own model provider and
key, so that a hosted PR Buddy does not pay for, or choose, everyone's AI review. Decisions are
in [BRAIN.md](BRAIN.md) (D-071 to D-081); threats and controls in [SECURITY.md](SECURITY.md),
section 6E.

## 1. What this delivers

- An installation can store one AI provider, model and key.
- Reviews of that installation's repositories use it, in place of the operator's provider.
- Owners of the installation manage it on the dashboard's settings page.
- The key is encrypted in the database, never shown again, and deleted on request or uninstall.

A repository still opts in with `"ai": { "enabled": true }` in `.github/pr-buddy.json` (D-042).
The key says who is asked and who pays; the repository file says which code may be sent.

## 2. The feature is optional

It exists only when the dashboard is on **and** `SECRETS_ENCRYPTION_KEY` is set. Without the
variable, nothing here is reachable and the service behaves as before (D-077).

## 3. Whose key, and who may change it

The key belongs to the **installation**, not to a person (D-071): a review is started by a
webhook when nobody is signed in, and it must find its key from the installation alone.

| Installation is on | Who may set, replace or remove the key                        |
| ------------------ | ------------------------------------------------------------- |
| A personal account | That person                                                   |
| An organisation    | A member whose role in the organisation is `admin` (an owner) |

This is stricter than reading. Anyone GitHub lists for an installation may read its history, but
only an owner may decide where the whole installation's code is sent (D-072).

The role is read from GitHub at sign-in, with the same one-time user token that lists the
installations (D-049), and kept in the session:

```
GET /user/installations                 → installations, each with its account and type
GET /user/memberships/orgs/{org}        → role "admin" and state "active" make an owner
```

If GitHub does not answer the membership question with a clear yes, the person is not treated
as an owner. Like read access (D-050), the role is a snapshot: a demoted owner can still change
the key until their session ends, at most eight hours later.

## 4. Providers a customer may choose

| Provider    | Customer supplies              | Requests go to                           |
| ----------- | ------------------------------ | ---------------------------------------- |
| `anthropic` | Model, API key                 | `api.anthropic.com`                      |
| `openai`    | Model, API key                 | `api.openai.com`                         |
| `bedrock`   | Model, region, Bedrock API key | `bedrock-runtime.<region>.amazonaws.com` |
| `azure`     | Deployment, resource name, key | `<resource>.openai.azure.com`            |

A customer **cannot** supply an address (D-074): one typed by a customer could point the service
at its own network. The region is checked against the same strict pattern as the operator's.

**Azure AI Foundry and Azure OpenAI (D-080).** The operator configures Azure with an address.
A customer gives the **name of their resource** instead, and the service builds the address
from it: `https://<resource>.openai.azure.com/openai/v1`. The name may hold only lower-case
letters, digits and hyphens, 2 to 64 characters, and may not start or end with a hyphen, so it
cannot contain a dot, a slash, a colon or an `@`. Whatever is typed, the request goes to a host
under `openai.azure.com`, which Microsoft controls. The model field holds the name of the
deployment. Resources in Azure's government and China clouds use other domains and are not
supported. `openai-compatible` has no fixed host and stays with the operator.

## 5. Storing the key

```
installation_ai_keys
  installation_id   primary key
  provider, model, region
  resource          the Azure resource name; only for azure
  key_ciphertext    AES-256-GCM
  key_nonce         12 random bytes, new for every save
  key_id            which master key encrypted it
  key_hint          the last four characters of the key
  updated_by        GitHub user ID
  updated_at
```

- **Encryption.** AES-256-GCM with the master key from `SECRETS_ENCRYPTION_KEY`, which is 32
  random bytes in base64 and never in the database (D-073). A copy of the database alone
  reveals no key.
- **Bound to its row.** The installation ID and provider are authenticated with the ciphertext,
  so a ciphertext copied to another installation's row does not decrypt.
- **Rotation.** Each row records which master key encrypted it. `SECRETS_ENCRYPTION_KEY_PREVIOUS`
  lets rows written under the old key still be read; saving a key again re-encrypts it.
- **Behind an interface.** Encryption is a `SecretCipher` with `encrypt` and `decrypt`, so a key
  service such as AWS KMS can replace the environment variable without touching stored rows'
  shape.
- **Write-only.** No API returns a key. The dashboard shows the provider, model and the last
  four characters.
- **Deleted** when an owner removes it, and with the installation when the app is uninstalled.

What encryption does not do: the running service must decrypt a key to use it, so someone who
takes over the running service can obtain keys. Customers should create a key for PR Buddy only,
with a spending limit.

## 6. API

All routes need a session. Reading needs the installation in the session; writing needs the
session to hold the owner role for it. An installation outside the session answers `404`, as
elsewhere (D-054).

| Route                                     | Does                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/installations`                  | The session's installations: account, `canManage`, key summary    |
| `PUT /api/installations/:id/ai-key`       | Checks the key with the provider, then stores it                  |
| `DELETE /api/installations/:id/ai-key`    | Removes it                                                        |
| `POST /api/installations/:id/ai-key/test` | Asks the provider once with the stored key and reports the result |

These are the dashboard's first requests that change something (D-075). The test changes
nothing, but it spends a little on the customer's key, so it has the same locks. Each one must:

- carry the session cookie, which is `SameSite=Lax`;
- have an `Origin` equal to the dashboard's own;
- carry the header `X-PR-Buddy-Request: 1`, which a form on another site cannot send;
- be JSON, validated field by field.

**Checked before it is stored (D-076).** `PUT` sends one very small request to the provider with
the new key. A provider that refuses it answers `401`, `403` or `404`, and the key is not saved;
the dashboard says which. A typing mistake is therefore found at once and not at the next pull
request.

**Tested on request (D-081).** A key that was accepted when saved can stop working later: it
expires, is revoked, runs out of credit, or loses access to the model. `POST …/ai-key/test`
decrypts the stored key, sends the same very small request, and answers `200` with one of:

| `result`      | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `working`     | The provider answered                                                |
| `refused`     | The provider answered with an error; `providerStatus` holds the code |
| `unreachable` | The provider did not answer, or answered something unreadable        |
| `unreadable`  | The stored key could not be decrypted; it must be entered again      |
| `missing`     | The installation has no key                                          |

Nothing from a pull request is sent, nothing is stored, and the answer never contains the key
or the provider's words. Only an owner may run it.

Every change writes an audit row: installation, GitHub user ID, action, time. Never the key.

## 7. Which provider a review uses

```
repository opted in?  no ──► no AI review
        │ yes
installation has its own key?  yes ──► that provider
        │ no
operator configured AI_PROVIDER?  yes ──► the operator's
        │ no
no AI review
```

An installation's own key always wins over the operator's (D-078). If its key cannot be
decrypted, or its provider refuses it, the review carries on with the rule findings and the
comment says the AI review could not be completed, as for any provider failure (D-048). It does
**not** fall back to the operator's provider: code would then go somewhere the customer did not
choose.

## 8. Dashboard

The settings page gains a section, "AI review", with one block per installation:

- the account's name and whether a key is set: provider, model, last four characters, when;
- for an owner: a form with provider, model, region (Bedrock only), resource name (Azure only)
  and key, and "Save key" and "Remove key" buttons; removal asks for confirmation;
- for an owner, when a key is set: a "Test key" button, whose result is shown below it;
- for anyone else: the same summary and a sentence saying that an owner can change it.

States: saving, saved, the provider refused the key (with the status), the form is invalid,
permission was lost, the service could not be reached. The key field is a password field that
is cleared after saving.

## 9. Limits

- The role is a snapshot from sign-in.
- One key per installation, not per repository.
- No usage or spending report: the provider's own console has that.
- The membership check has not been run against a real organisation; see the tracker.
- Azure has not been run against a real resource; see the tracker.
- A test shows that the provider accepts the key and knows the model. It does not show that a
  repository has opted in.
