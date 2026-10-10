# Design: the AI reviewer

How PR Buddy asks a language model for review suggestions, and how it keeps that optional,
bounded and clearly separate from its deterministic checks. Decisions are recorded in
[BRAIN.md](BRAIN.md) (D-041 to D-048); threats and controls are in [SECURITY.md](SECURITY.md).

## 1. What this part delivers

- A package, `@pr-buddy/ai-reviewer`, that turns a validated pull request into a prompt, sends it
  to a provider, and turns the answer into verified findings.
- A provider interface. **No real provider ships yet**: which service receives code is the
  operator's choice and has not been made (D-041). A scripted provider exists for tests.
- Wiring in the review service, the summary comment and storage, all of which do nothing until a
  provider is supplied.

Until a provider is added, a running PR Buddy behaves exactly as before.

## 2. Two switches, both off by default

| Switch     | Who sets it          | Where                                                  |
| ---------- | -------------------- | ------------------------------------------------------ |
| Provider   | The operator         | Passed to `createReviewService` as `aiReviewer`        |
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

## 10. Adding a provider

1. Implement `AiProvider`: a `name`, a `model`, and `complete(request)` returning the reply text
   and, if known, token usage. Honour `request.signal` and `request.maxOutputTokens`.
2. Read its key and model from the environment in `apps/api/src/config/env.ts`, and add the key
   to the logger's redaction list.
3. Pass `createAiReviewer({ provider })` to `createReviewService` in `main.ts`.
4. Document in the README which service receives code and how it handles it.

## 11. Testing

Unit tests drive the reviewer with a scripted provider: file selection and budgets, the prompt's
shape, every way an answer can be malformed, location checks, thresholds, time-outs and provider
errors. Service tests cover both switches, the comment, storage and logs, with canary strings to
show that no prompt or reply text reaches the logs.

Not covered, because it needs a real model: whether the instructions resist a determined prompt
injection. The controls in section 6 are written on the assumption that they sometimes will not.
