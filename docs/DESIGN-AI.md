# Design: the AI reviewer

How PR Buddy asks a language model for review suggestions, and how it keeps that optional,
bounded and clearly separate from its deterministic checks. Decisions are recorded in
[BRAIN.md](BRAIN.md) (D-041 to D-048); threats and controls are in [SECURITY.md](SECURITY.md).

> This document describes **hosted mode**: one request, from the diff, on the service. A second
> way to run PR Buddy, in a repository's own CI with read-only tools over the checkout, is
> designed in [DESIGN-RUNNER.md](DESIGN-RUNNER.md) and not built. It changes nothing here: hosted
> mode keeps its single request, its summary-only suggestions and its limits.

## 1. What this part delivers

- A package, `@pr-buddy/ai-reviewer`, that turns a validated pull request into a prompt, sends it
  to a provider, and turns the answer into verified findings.
- A provider interface and five providers: AWS Bedrock, Anthropic, OpenAI, Azure AI Foundry and
  any OpenAI-compatible service (section 10). A scripted provider exists for tests.
- Wiring in the review service, the summary comment and storage, all of which do nothing until a
  provider is configured.

Until the operator sets `AI_PROVIDER`, a running PR Buddy sends nothing to any model.

## 2. Two switches, both off by default

| Switch     | Who sets it          | Where                                                  |
| ---------- | -------------------- | ------------------------------------------------------ |
| Provider   | The operator         | `AI_PROVIDER` and its settings in the environment      |
| Repository | The repository owner | `"ai": { "enabled": true }` in `.github/pr-buddy.json` |

Both are needed (D-042). The repository file is read at the pull request's **base** commit, like
every other setting, so a contributor cannot turn the AI review on for their own pull request.
If a repository enables it and the operator has no provider, nothing happens.

## 3. Flow

```
ReviewContext (already validated by the engine)
   │
   ├─ select files ── leave out removed files, files without a patch, lockfiles,
   │                  credential-like files, and whatever exceeds the budget
   ├─ build prompt ── fixed instructions + one JSON document holding the PR content
   ├─ provider.complete() ── one request, time limit, no retry
   ├─ parse answer ── bounded length → JSON → schema, finding by finding
   ├─ verify ──────── finding schema, then file and line against the files that were sent
   └─ thresholds ──── the repository's minimum severity and confidence
```

The reviewer never throws for a problem with the provider or its answer. It returns a status of
`completed`, `skipped` (nothing to send) or `failed` (`timeout`, `provider-error`,
`invalid-response`).

## 4. What is sent

Only this (D-047):

- The pull request title, and its description cut to 4,000 characters.
- For each selected file: its path and the lines visible in its diff **after** the change, each
  with its line number and whether it was added. Removed lines are not sent.

| Limit                           | Value   |
| ------------------------------- | ------- |
| Files in one prompt             | 50      |
| Characters of code in a prompt  | 100,000 |
| Characters kept from one line   | 500     |
| Description characters          | 4,000   |
| Output tokens requested         | 2,000   |
| Characters accepted in a reply  | 50,000  |
| Time for the request            | 60 s    |
| Suggestions kept from one reply | 10      |

A file that does not fit is left out whole, never cut in the middle, and smaller files after it
may still fit. The comment says how many files were not sent. Hunks that do not match their
header are skipped, so every line number the model sees is one the engine can verify.

Never sent: files whose names suggest credentials (`.env`, `*.pem`, …, minus templates such as
`.env.example`), lockfiles, anything outside the diff, repository configuration, tokens.

## 5. The prompt

The system text is a constant. It states the task, says that everything in the user message is
data to review and never instructions to follow, and fixes the reply format: one JSON object,
`{"findings": [{"message", "severity", "filePath"?, "line"?, "suggestion"?}]}`.

The user message is a single `JSON.stringify` of the selected content. Encoding it as JSON means
no title, description or line of code can close a delimiter and pose as instructions in the
structure of the prompt (D-043). It does not stop a model from being persuaded by what the text
says; section 6 is what bounds the damage when that happens.

## 6. The answer is untrusted

Model output is treated like any other outside input:

1. Replies longer than 50,000 characters are rejected.
2. The reply must be a JSON object, optionally inside one Markdown code fence, with a `findings`
   array. Otherwise the review fails with `invalid-response`.
3. Each entry is checked alone. One that does not fit the schema is dropped and counted; the
   others are kept. Only the first 10 are looked at.
4. Each kept entry becomes a finding with rule ID `ai-review` and passes the engine's
   `findingSchema`.
5. Its file must be one that was sent and its line must be visible in that file's diff. A
   suggestion that points anywhere else is dropped, not kept without its location: a model that
   cites a line that does not exist is probably wrong about more than the number (D-043).

What the model cannot decide (D-044):

- **Confidence** is always 0.5. A model's own estimate is not calibrated evidence.
- **Severity** is at most `high`. `critical` is lowered to `high`.
- **Rule ID and evidence** are set by PR Buddy.

Everything a suggestion says is published through `escapeMarkdown`, so it cannot create links,
mentions, images or HTML, whatever a pull request talked the model into writing.

## 7. Where suggestions appear

In the summary comment, in their own section below the deterministic findings, under a line that
says they were written by a model, names it, and says they are not verified. The footer changes
from "Deterministic checks only" to say that suggestions are included.

They are **not** posted as line comments (D-045). Line comments are matched between reviews by
their text; a model words the same point differently each time, so every push would delete and
repost them.

The repository's reporting thresholds apply. With the fixed confidence of 0.5, setting
`report.minConfidence` above 0.5 hides every AI suggestion while keeping the rules that are more
certain.

## 8. Failure

The AI review runs after the rules and before the stale-head check. If it fails, the review
carries on with the rule findings, the comment's notes say the AI review could not be completed,
and the log records the status and the error's name (D-048). The error's message is not logged:
a provider may echo part of the prompt in it.

There is one request per review and no retry. A second attempt doubles the cost of a review for
a result that is optional.

## 9. Storage

One row per AI review in `ai_reviews`: provider, model, status, failure reason, counts, token
usage and duration. **The text of AI suggestions is not stored** (D-046): it is written by a
model that has read the code and may quote it, and the database holds no source code
(D-031). The suggestions stay readable on the pull request.

## 10. Providers

Five providers ship. The operator picks one with `AI_PROVIDER`; with none set, nothing is sent
anywhere. Each is a small adapter over `fetch`: no vendor SDK is installed (D-060).

| `AI_PROVIDER`       | Service                         | Endpoint used                                      | Credentials                                             |
| ------------------- | ------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `bedrock`           | AWS Bedrock                     | Converse API in `AWS_REGION`                       | A Bedrock API key, or an AWS access key (signed, SigV4) |
| `anthropic`         | Anthropic                       | Messages API                                       | `AI_API_KEY`                                            |
| `openai`            | OpenAI                          | Chat Completions                                   | `AI_API_KEY`                                            |
| `azure`             | Azure AI Foundry / Azure OpenAI | Chat Completions under the resource's `/openai/v1` | `AI_API_KEY`, sent as `api-key`                         |
| `openai-compatible` | Anything that speaks that API   | Chat Completions at `AI_BASE_URL`                  | `AI_API_KEY`, optional                                  |

| Variable                                     | Needed for                                                     |
| -------------------------------------------- | -------------------------------------------------------------- |
| `AI_PROVIDER`                                | Turning AI review on                                           |
| `AI_MODEL`                                   | Every provider. There is no default: the model decides cost    |
| `AI_API_KEY`                                 | `anthropic`, `openai`, `azure`; optional for the other two     |
| `AI_BASE_URL`                                | `azure`, `openai-compatible`; optional override for the others |
| `AWS_REGION`                                 | `bedrock`                                                      |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `bedrock`, unless a Bedrock API key is given                   |
| `AWS_SESSION_TOKEN`                          | `bedrock`, with temporary credentials                          |
| `AWS_BEARER_TOKEN_BEDROCK`                   | `bedrock`: a Bedrock API key, instead of an access key         |
| `AI_TIMEOUT_MS`                              | Optional; 60,000 by default                                    |

Rules that hold for every adapter:

- `AI_BASE_URL` must be `https://`, or `http://` on the local machine for a model run locally.
- A reply that is not `2xx` becomes an error named after its status, such as `ProviderHttp429`.
  The body of an error reply is never read into the error: it can echo the prompt.
- The request's abort signal and output-token limit are passed on.
- Token usage is read when the service reports it.
- Credentials are read from the environment once, are redacted in logs, and are not part of any
  error.

A setting that does not fit the chosen provider stops the service at start-up with a message that
names the variable, like every other setting.

### Bedrock

Bedrock is called through its Converse API, which has one request shape for every model family.
With an access key the request is signed with AWS Signature Version 4, implemented in
`providers/sigv4.ts` and checked against AWS's published test values. Credentials come from the
environment only: instance roles, profiles and single sign-on are not looked up (D-060).

`AI_MODEL` is a model ID or an inference profile ID, for example one that starts with `us.`.
The AWS account must have been granted access to that model in that region.

### What has been run against a real service

As of 2026-10-10: Bedrock with a Bedrock API key, using a Claude model through an inference
profile. The other adapters, and Bedrock with a signed access key, are written from published
APIs and tested against stand-ins; treat each as unproven until it has answered once. The tracker
has the details.

### Adding another

1. Implement `AiProvider` in `packages/ai-reviewer/src/providers/`: a `name`, a `model`, and
   `complete(request)` returning the reply text and, if known, token usage.
2. Add it to `createProvider` and to the settings schema in `provider-settings.ts`.
3. Document which service receives code.

## 11. Testing

Unit tests drive the reviewer with a scripted provider: file selection and budgets, the prompt's
shape, every way an answer can be malformed, location checks, thresholds, time-outs and provider
errors. Service tests cover both switches, the comment, storage and logs, with canary strings to
show that no prompt or reply text reaches the logs.

Not covered, because it needs a real model: whether the instructions resist a determined prompt
injection. The controls in section 6 are written on the assumption that they sometimes will not.
