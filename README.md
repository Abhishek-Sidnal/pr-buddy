# PR Buddy

An open-source assistant that reviews GitHub pull requests. It reports a small number of
actionable findings, shows the evidence behind each one, and leaves the merge decision to people.

> **Status: Milestone 1.** The deterministic review engine is implemented and tested. The GitHub
> App, dashboard and optional AI review are planned and are not in this repository yet. See the
> [tracker](docs/TRACKER.md).

## What exists today

`@pr-buddy/review-engine` is a TypeScript library that takes a description of a pull request and
returns validated findings. It has no knowledge of GitHub, HTTP or databases.

```ts
import { createReviewEngine } from "@pr-buddy/review-engine";

const engine = createReviewEngine({
  config: { rules: { "max-changed-files": { options: { maxFiles: 20 } } } },
});

const result = await engine.review({
  pullRequest: {
    number: 42,
    title: "Add user lookup",
    body: null,
    baseSha: "3f2a9c1d5e7b8a0f4c6d2e1b9a8f7c6d5e4b3a21",
    headSha: "9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c",
  },
  files: [{ path: "src/user.service.ts", status: "added", additions: 10, deletions: 0 }],
});

console.log(result.findings);
```

```json
[
  {
    "ruleId": "missing-test-changes",
    "severity": "low",
    "confidence": 0.6,
    "message": "The pull request edits 1 source file but no test files. This is a signal, not proof: existing tests may already cover the change.",
    "evidence": [
      { "label": "Edited source files", "value": "src/user.service.ts" },
      {
        "label": "Test file patterns checked",
        "value": "**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}, **/__tests__/**, **/{test,tests,e2e}/**"
      }
    ],
    "suggestion": "If the change affects behaviour, add or update tests. If existing tests already cover it, no action is needed."
  },
  {
    "ruleId": "pr-description",
    "severity": "low",
    "confidence": 1,
    "message": "The pull request has no description.",
    "evidence": [
      {
        "label": "Description length",
        "value": "0 characters, not counting headings and HTML comments"
      },
      { "label": "Configured minimum", "value": "30 characters" }
    ],
    "suggestion": "Describe what the change does, why it is needed and how it was tested."
  }
]
```

### Built-in rules

| Rule                   | Reports                                                |
| ---------------------- | ------------------------------------------------------ |
| `pr-description`       | A missing or very short description                    |
| `max-changed-files`    | More changed files than the configured maximum         |
| `missing-test-changes` | Source files edited without any test file being edited |

Options, examples and limitations of each rule are in the [rule reference](docs/RULES.md). An
example configuration is in [examples/prbuddy.config.json](examples/prbuddy.config.json).

## Getting started

You need [Docker](https://docs.docker.com/get-docker/). Node.js runs inside a container, so
nothing else is installed on your machine.

Install the dependencies:

```bash
docker compose run --rm dev npm install
```

Run every check: formatting, lint, type-check, tests with coverage, and build.

```bash
docker compose run --rm dev npm run check
```

Run only the tests:

```bash
docker compose run --rm dev npm test
```

If you have Node.js 22.12 or newer installed, the same npm scripts work without the
`docker compose run --rm dev` prefix.

## Architecture in brief

```
review input ─► validate ─► freeze ─► run rules ─► validate findings ─► verify locations ─► order
 (untrusted)     (Zod)                (isolated,     (schema)            (against the diff)
                                       time-limited)
```

- **Input is untrusted.** Everything is validated and size-limited before a rule sees it.
- **Rules are isolated.** A rule that throws or exceeds its time limit is recorded as failed and
  the other rules still report.
- **Locations are verified.** A file must be in the diff and a line must be in that file's patch;
  anything else is removed from the finding. The engine never reports an invented location.
- **The engine is pure.** No file, network or process access, and nothing from a reviewed
  repository is ever executed. ESLint enforces this.

More detail: [architecture](docs/ARCHITECTURE.md) · [design](docs/DESIGN.md) ·
[security](docs/SECURITY.md).

## Known limitations

- There is no GitHub integration yet: the caller must build the review input.
- The built-in rules look at pull request metadata and file names only. None inspects code.
- `missing-test-changes` is a heuristic. It cannot tell whether existing tests cover a change.
- `pr-description` measures length, not quality.
- Default patterns cover JavaScript and TypeScript projects only.
- Findings can point at added or unchanged lines, not at removed lines.
- The rule time limit cannot interrupt a synchronous rule that never returns; see the
  [security design](docs/SECURITY.md).
- Configuration is a JavaScript object. Reading a configuration file is left to the integration.
- The glob dialect is small on purpose: no character classes, negation or escaping.

## Documentation

| Document                             | Contents                                        |
| ------------------------------------ | ----------------------------------------------- |
| [Context](docs/CONTEXT.md)           | Start here: orientation, commands, ground rules |
| [Product requirements](docs/PRD.md)  | What is being built and why                     |
| [Architecture](docs/ARCHITECTURE.md) | Modules and their boundaries                    |
| [Design](docs/DESIGN.md)             | Data contracts, pipeline, limits                |
| [Rules](docs/RULES.md)               | Reference for the built-in rules                |
| [Security](docs/SECURITY.md)         | Threat model and controls                       |
| [Brain](docs/BRAIN.md)               | Decisions and their reasons                     |
| [Tracker](docs/TRACKER.md)           | Status of the work                              |

## Roadmap

| Milestone | Deliverable                                      | Status      |
| --------- | ------------------------------------------------ | ----------- |
| M1        | Deterministic review engine                      | Implemented |
| M2        | GitHub App: webhooks, diffs, published reviews   | Planned     |
| M3        | Optional AI review, policy thresholds, dashboard | Planned     |
| M4        | Hardening and `v0.1.0`                           | Planned     |

PR Buddy does not merge pull requests or change code.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

[MIT](LICENSE)
