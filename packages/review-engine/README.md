# @pr-buddy/review-engine

The deterministic review engine of [PR Buddy](../../README.md). It takes a description of a pull
request and returns validated, evidence-backed findings. It performs no I/O and never executes
code from the repository it reviews.

## Usage

```ts
import { createReviewEngine } from "@pr-buddy/review-engine";

const engine = createReviewEngine({ config });
const result = await engine.review(context);
```

- `createReviewEngine` throws `ConfigurationError` if `config` is invalid.
- `engine.review` rejects with `InvalidContextError` if `context` is invalid.
- A rule that fails is reported in `result.rules`; it does not reject the review.

The input, output and configuration formats are specified in the
[design document](../../docs/DESIGN.md). The built-in rules are described in the
[rule reference](../../docs/RULES.md), which also shows how to write your own.

## Layout

```
src/
├── index.ts     Public API
├── limits.ts    Size and time limits
├── errors.ts    Error classes
├── context/     Review input schema and safe paths
├── config/      Configuration schema and resolution
├── diff/        Patch parser
├── findings/    Finding schema, location validation, ordering
├── rules/       Rule contract, registry, built-in rules
├── engine/      The review pipeline
└── utils/       Shared helpers
tests/
├── unit/        Mirrors src/
├── integration/ Whole-engine tests against fixtures
├── fixtures/    Realistic review inputs as JSON
└── helpers/     Builders and fixture loaders
```

## Scripts

| Script                  | Does                        |
| ----------------------- | --------------------------- |
| `npm test`              | Run the tests once          |
| `npm run test:watch`    | Run the tests on change     |
| `npm run test:coverage` | Run the tests with coverage |
| `npm run typecheck`     | Type-check source and tests |
| `npm run build`         | Compile `src/` to `dist/`   |

Run them from the repository root through Docker, for example
`docker compose run --rm dev npm test`.
