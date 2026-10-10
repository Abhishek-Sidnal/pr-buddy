# PR Buddy — Context

The fastest way to get oriented, for a new contributor or an AI coding assistant. Read this first.

## What this is

PR Buddy is an open-source assistant that reviews GitHub pull requests and reports a small number
of actionable, evidence-backed findings. Humans keep the merge decision.

## Current state

- **Milestone 1** — the deterministic review engine — is the only code in the repository.
- There is no GitHub App, API, database, dashboard or AI integration yet.
- Live status: [TRACKER.md](TRACKER.md).

## Where things are

| Path                                   | Contents                                          |
| -------------------------------------- | ------------------------------------------------- |
| `packages/review-engine/src/index.ts`  | Public API of the engine                          |
| `packages/review-engine/src/engine/`   | The review pipeline                               |
| `packages/review-engine/src/rules/`    | Rule contract, registry, built-in rules           |
| `packages/review-engine/src/context/`  | Input schema and path safety                      |
| `packages/review-engine/src/findings/` | Finding schema, location validation, ordering     |
| `packages/review-engine/src/config/`   | Configuration schema and resolution               |
| `packages/review-engine/src/diff/`     | Patch parser                                      |
| `packages/review-engine/src/limits.ts` | Every size and time limit                         |
| `packages/review-engine/tests/`        | Unit tests, integration tests, fixtures, builders |
| `examples/prbuddy.config.json`         | Example configuration, loaded by a test           |

## Documents

| Document                                 | Read it for                                                       |
| ---------------------------------------- | ----------------------------------------------------------------- |
| [PRD.md](PRD.md)                         | What is being built and why; requirements and acceptance criteria |
| [ARCHITECTURE.md](ARCHITECTURE.md)       | Module boundaries and the rules for dependencies                  |
| [DESIGN.md](DESIGN.md)                   | Data contracts, pipeline details, limits                          |
| [RULES.md](RULES.md)                     | Reference for each built-in review rule                           |
| [SECURITY.md](SECURITY.md)               | Threat model and controls                                         |
| [BRAIN.md](BRAIN.md)                     | Decisions and their reasons, glossary, open questions             |
| [TRACKER.md](TRACKER.md)                 | Status of every task                                              |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Coding rules and the workflow for changes                         |

## Commands

Node.js runs inside Docker; nothing is installed on the host.

```bash
docker compose run --rm dev npm install
```

```bash
docker compose run --rm dev npm run check
```

| Script                  | Does                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `npm run check`         | Format check, lint, type-check, tests with coverage, build |
| `npm test`              | Tests once                                                 |
| `npm run test:coverage` | Tests with a coverage report                               |
| `npm run lint`          | ESLint                                                     |
| `npm run typecheck`     | TypeScript without emitting                                |
| `npm run format`        | Prettier, writing changes                                  |
| `npm run build`         | Compile to `dist/`                                         |

With Node.js 22.12 or newer installed locally, the same scripts work without the
`docker compose run --rm dev` prefix.

## Rules that must not be broken

1. The engine does no I/O: no file system, network, process or environment access in
   `packages/review-engine/src`.
2. Nothing from a reviewed repository is ever executed or evaluated.
3. Input and configuration are `unknown` at the public API and parsed with Zod.
4. Types come from schemas (`z.infer`); do not write a second definition.
5. A finding's file and line are verified against the diff or removed. Never invent one.
6. A finding does not claim more than its evidence supports.
7. Sizes and timeouts are constants in `limits.ts`.
8. Every rule has positive, negative and edge-case tests.
9. Do not build ahead of the current milestone.

## Conventions

- TypeScript strict mode, ES modules, relative imports end in `.js`.
- File names are kebab-case; rules are `<rule-id>.rule.ts`; schemas are `<name>.schema.ts`.
- Rule IDs are kebab-case and never reused for different behaviour.
- Named exports only.
- Tests are in `tests/unit/<module>/<file>.test.ts`, mirroring `src/`.

## When you finish a change

1. `npm run check` passes.
2. [TRACKER.md](TRACKER.md) reflects the new status.
3. A new decision is recorded in [BRAIN.md](BRAIN.md).
4. A changed rule is updated in [RULES.md](RULES.md) and its `version` is bumped.
