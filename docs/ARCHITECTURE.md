# PR Buddy — Architecture

This document describes how the system is divided and which part may depend on which. The
detailed behaviour of the review engine is in [DESIGN.md](DESIGN.md).

## 1. Target system (V1)

```
GitHub pull request event
        │
        ▼
Webhook API ── verify signature, validate event, drop duplicate deliveries      (M2)
        │
        ▼
Review job ── fetch changed files and patches, enforce size limits              (M2)
        │
        ▼
┌───────────────────────── review engine ─────────────────────────┐
│  validate input → run rules → validate findings → order results │            (M1)
└──────────────────────────────────────────────────────────────────┘
        │                         ▲
        │                         └── optional AI reviewer adds findings        (M3)
        ▼
Policy thresholds ── severity and confidence filters                            (M3)
        │
        ▼
GitHub review output ── summary, inline comments, check run                     (M2)
```

Only the review engine exists today. Everything else is planned and is not in the repository.

## 2. Repository layout

```
pr-buddy/
├── packages/
│   └── review-engine/        The deterministic review engine (Milestone 1)
│       ├── src/
│       └── tests/
├── examples/                 Example configuration
├── docs/                     Product, architecture, design, security, tracker, decisions
├── docker/                   Development container image
├── .github/                  CI workflow, issue and pull request templates
├── compose.yaml              Development container service
├── eslint.config.js          Lint rules for the whole repository
├── tsconfig.base.json        Compiler settings shared by every package
└── package.json              npm workspaces root and repository scripts
```

Planned additions, created only when their milestone starts:

| Path                      | Purpose                                                      | Milestone |
| ------------------------- | ------------------------------------------------------------ | --------- |
| `packages/github-client/` | Maps GitHub API data to a `ReviewContext`, publishes results | M2        |
| `apps/api/`               | Express API and webhook receiver                             | M2        |
| `apps/web/`               | React dashboard                                              | M3        |

## 3. Review engine modules

```
packages/review-engine/src/
├── index.ts          Public API. The only file other packages import.
├── limits.ts         Every size and time limit, in one place
├── errors.ts         Error classes thrown across the public API
├── context/          Review input: schema, types, safe-path validation
├── config/           Engine configuration: schema and resolution against the registry
├── diff/             Unified-diff patch parser
├── findings/         Finding schema, severity, location validation, ordering
├── rules/            Rule contract, registry and the built-in rules
├── engine/           Orchestration: runs rules and assembles the result
└── utils/            Small pure helpers shared by the modules above
```

| Module     | Responsibility                                        | May import from                                    |
| ---------- | ----------------------------------------------------- | -------------------------------------------------- |
| `utils`    | Generic helpers: globs, freezing, timeouts, text      | `limits`                                           |
| `context`  | Define and validate review input                      | `utils`, `limits`, `errors`                        |
| `diff`     | Turn a patch string into hunks and line numbers       | —                                                  |
| `findings` | Define findings; validate their locations; order them | `context`, `diff`, `utils`, `limits`               |
| `rules`    | Rule contract, registry, built-in rules               | `context`, `findings`, `utils`, `limits`, `errors` |
| `config`   | Validate configuration and resolve it per rule        | `rules`, `findings`, `utils`, `errors`             |
| `engine`   | Run the pipeline                                      | all of the above                                   |

Dependencies point one way, from `engine` down to `utils`. A lower module never imports a higher
one, and there are no import cycles.

## 4. Review pipeline

`createReviewEngine(options)` runs once and fails fast:

1. Validate the configuration object.
2. Reject settings for rule IDs that are not registered.
3. Validate each rule's options with that rule's own schema.

`engine.review(input)` runs for every pull request:

1. **Validate input.** The context is parsed with Zod; unknown fields, unsafe paths and oversized
   values are rejected.
2. **Freeze.** The parsed context is deep-frozen so no rule can change what another rule sees.
3. **Run rules.** Each enabled rule runs in isolation with a time limit. A rule that throws or
   times out is recorded as failed and the others continue.
4. **Validate findings.** Each finding a rule returns is checked against the finding schema. The
   engine, not the rule, stamps the rule ID and the resolved severity.
5. **Validate locations.** A file must be part of the diff and a line must be on the new side of
   that file's patch. A location that fails is removed and a diagnostic is recorded.
6. **Deduplicate and order.** Identical findings collapse; the rest are sorted by severity, file,
   line and rule.
7. **Return** findings, per-rule execution records, diagnostics and a summary.

## 5. Architectural rules

These hold for every change. Several are enforced by ESLint or the compiler.

1. **The engine is pure.** No file system, network, process or environment access in
   `packages/review-engine/src`. ESLint blocks the relevant Node.js modules.
2. **No reviewed code is executed.** No `eval`, `new Function`, `vm` or dynamic `import()` of
   content that came from a pull request.
3. **Everything crossing the public API is validated.** Input and configuration are typed
   `unknown` at the boundary and parsed with Zod.
4. **Schemas are the source of truth.** Types are inferred from Zod schemas, never written twice.
5. **Rules do not depend on each other** and do not share mutable state.
6. **Limits live in `limits.ts`.** No magic numbers for sizes or timeouts elsewhere.
7. **One public entry point.** Consumers import from the package root only.

## 6. Extension points

| To add              | Do this                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A built-in rule     | Create `rules/<name>.rule.ts` with `defineRule`, add it to `rules/builtin.ts`, add tests, document it in [RULES.md](RULES.md) |
| A custom rule       | Call `defineRule` in your own code and `register` it on a `RuleRegistry` passed to `createReviewEngine`                       |
| A new integration   | Build a `ReviewContext` from your source and call `engine.review`                                                             |
| An AI reviewer (M3) | Produce findings with the same schema and pass them through the same location validation                                      |

## 7. Technology choices

| Concern                 | Choice                                                | Reason                                                                        |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Language                | TypeScript, strict                                    | One language across engine, API and dashboard                                 |
| Modules                 | ES modules, Node.js 22+                               | Current Node.js standard                                                      |
| Validation              | Zod                                                   | Runtime validation and static types from one definition                       |
| Glob matching           | Own matcher in `utils/glob.ts`                        | Bounded cost on hostile input; see D-011 in [BRAIN.md](BRAIN.md)              |
| Tests                   | Vitest                                                | Fast, native TypeScript and ESM                                               |
| Lint and format         | ESLint (typescript-eslint, type-checked) and Prettier | Standard tooling                                                              |
| Monorepo                | npm workspaces                                        | No extra tool to install                                                      |
| Development environment | Docker Compose                                        | The same Node.js version for every contributor, nothing installed on the host |

The reasoning behind each decision is recorded in [BRAIN.md](BRAIN.md).
