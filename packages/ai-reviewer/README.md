# @pr-buddy/ai-reviewer

The optional AI reviewer of [PR Buddy](../../README.md). It turns a validated pull request into a
prompt, sends it to a provider, and returns only the suggestions it can verify against the diff.

No provider is included. Until one is supplied, nothing is sent anywhere.

## Usage

```ts
import { createAiReviewer } from "@pr-buddy/ai-reviewer";

const reviewer = createAiReviewer({ provider });
const review = await reviewer.review(context, engine.thresholds);
```

- `context` is a `ReviewContext` already validated by the review engine.
- `review` never rejects because of the provider or its reply. Check `review.status`:
  `completed`, `skipped` (nothing could be sent) or `failed`.
- Findings carry the rule ID `ai-review`, a fixed confidence of 0.5 and a severity of at most
  `high`.

## Writing a provider

Implement `AiProvider`: a `name`, a `model` and `complete(request)`, which returns the reply text
and, if known, token usage. Honour `request.signal` and `request.maxOutputTokens`, and keep
credentials and request content out of thrown errors.

What is sent, how replies are checked and every limit are described in the
[design document](../../docs/DESIGN-AI.md).
