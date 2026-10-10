# @pr-buddy/github-client

Everything [PR Buddy](../../README.md) knows about GitHub. Other packages reach GitHub only
through this one.

| Area       | What it provides                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Webhooks   | `verifyWebhookSignature`, `parsePullRequestEvent`                                                |
| API access | The `RepositoryClient` interface and `createRepositoryClientFactory`, its Octokit implementation |
| Mapping    | `toReviewContext`: GitHub's pull request data as review engine input                             |
| Output     | `renderReviewSummary`, `publishReviewSummary`                                                    |

Application code depends on the `RepositoryClient` interface, not on Octokit, so it can be tested
with an in-memory implementation.

Design and security notes: [docs/DESIGN-GITHUB.md](../../docs/DESIGN-GITHUB.md).

## Layout

```
src/
├── index.ts     Public API
├── webhook/     Signature verification and event parsing
├── api/         RepositoryClient interface, Octokit implementation, retry
├── mapping/     GitHub data to review engine input
└── output/      Markdown rendering and comment publishing
tests/unit/      One test file per area; GitHub is replaced by a stubbed fetch
```

## Scripts

Run from the repository root, for example `docker compose run --rm dev npm test`. This package
imports the compiled review engine, so run `npm run build` first after changing the engine.
