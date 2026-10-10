# PR Buddy — Architecture

This document describes how the system is divided and which part may depend on which. Detailed
behaviour is in [DESIGN.md](DESIGN.md) (review engine) and [DESIGN-GITHUB.md](DESIGN-GITHUB.md)
(GitHub App).

## 1. System

```
GitHub pull request event
        │
        ▼
Webhook endpoint ── verify signature, drop repeats, filter events        apps/api
        │
        ▼
Review queue ── one review at a time per pull request                    apps/api
        │
        ▼
Review service ── fetch pull request, files and configuration            apps/api
        │              through the GitHub client                         packages/github-client
        ▼
Review engine ── validate input → run rules → validate findings          packages/review-engine
        │
        ▼
Summary comment ── rendered and published by the GitHub client           packages/github-client
```

Planned and not in the repository: an optional AI reviewer and policy thresholds (M3), a database
and dashboard (M3).

## 2. Repository layout

```
pr-buddy/
├── apps/
│   └── api/                  HTTP service: webhooks, queue, review orchestration
├── packages/
│   ├── review-engine/        Deterministic review engine
│   └── github-client/        Everything that knows GitHub's formats and API
├── examples/                 Example configuration
├── docs/                     Product, architecture, design, security, tracker, decisions
├── docker/                   Development image and the API's production image
├── .github/                  CI workflow, issue and pull request templates
├── compose.yaml              Development container and the API service
├── eslint.config.js          Lint rules for the whole repository
├── tsconfig.base.json        Compiler settings shared by every package
└── package.json              npm workspaces root and repository scripts
```

| Planned path | Purpose         | Milestone |
| ------------ | --------------- | --------- |
| `apps/web/`  | React dashboard | M3        |

## 3. Package dependencies

```
apps/api ──► packages/github-client ──► packages/review-engine
    └──────────────────────────────────────────►┘
```

Dependencies point one way. The engine knows nothing about GitHub or HTTP; the GitHub client
knows nothing about Express; only the API knows how they are combined.

Packages import each other's compiled output, so `npm run build` runs before lint, type-check and
tests. The workspaces are listed in dependency order in the root `package.json`.

## 4. Review engine modules

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

The pipeline: validate input → freeze it → run each rule in isolation with a time limit →
validate each finding → verify each location against the diff → deduplicate and order.

## 5. GitHub client modules

```
packages/github-client/src/
├── index.ts          Public API
├── webhook/          Signature verification; pull request event parsing
├── api/              RepositoryClient interface; its Octokit implementation; retry
├── mapping/          GitHub pull request data → review engine input
└── output/           Summary rendering as safe Markdown; comment publishing
```

`RepositoryClient` is the boundary. It lists the six GitHub operations PR Buddy needs. The API
depends on that interface and never on Octokit.

## 6. API modules

```
apps/api/src/
├── main.ts           Entry point: environment, wiring, listen, graceful shutdown
├── app.ts            Express application: headers, rate limit, routes, error handling
├── logger.ts         Structured logging with redaction
├── config/           Environment variables, validated at start-up
└── modules/
    ├── github/       Webhook endpoint; delivery store
    └── reviews/      Review queue; review service
```

`main.ts` is the only file that reads the environment or creates real clients. Everything else
receives its dependencies as arguments, which is what makes it testable.

## 7. Architectural rules

These hold for every change. Several are enforced by ESLint or the compiler.

1. **The engine is pure.** No file system, network, process or environment access in
   `packages/review-engine/src`. ESLint blocks the relevant Node.js modules.
2. **No reviewed code is executed.** No `eval`, `new Function`, `vm` or dynamic `import()`, and
   nothing from a pull request is checked out, installed or run.
3. **Everything crossing a boundary is validated.** Engine input, configuration, webhook bodies
   and environment variables are parsed with Zod before use.
4. **Schemas are the source of truth.** Types are inferred from Zod schemas, never written twice.
5. **GitHub stays in one package.** Only `github-client` imports Octokit or knows GitHub's
   payload and Markdown formats.
6. **A webhook is a trigger, not data.** What is reviewed is fetched from the API.
7. **Dependencies are passed in.** Modules receive clients, stores and loggers as arguments.
8. **Limits live in one place per package.** No magic numbers for sizes or timeouts.
9. **One public entry point per package.** Consumers import from the package root only.

## 8. Extension points

| To add                  | Do this                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A built-in rule         | Create `rules/<name>.rule.ts` with `defineRule`, add it to `rules/builtin.ts`, add tests, document it in [RULES.md](RULES.md) |
| A custom rule           | Call `defineRule` in your own code and `register` it on a `RuleRegistry` passed to `createReviewEngine`                       |
| Durable delivery memory | Implement the `DeliveryStore` interface over a database                                                                       |
| Another platform        | Add a client package that produces a `ReviewContext` and publishes a `ReviewResult`                                           |
| An AI reviewer (M3)     | Produce findings with the same schema and pass them through the same location validation                                      |

## 9. Technology choices

| Concern                 | Choice                                                | Reason                                                           |
| ----------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| Language                | TypeScript, strict                                    | One language across engine, API and dashboard                    |
| Modules                 | ES modules, Node.js 22+                               | Current Node.js standard                                         |
| Validation              | Zod                                                   | Runtime validation and static types from one definition          |
| Glob matching           | Own matcher in `utils/glob.ts`                        | Bounded cost on hostile input; see D-011 in [BRAIN.md](BRAIN.md) |
| HTTP                    | Express 5                                             | Small, widely understood, async error handling built in          |
| GitHub API              | Octokit with GitHub App authentication                | Official client; issues and refreshes installation tokens        |
| Logging                 | pino                                                  | Structured JSON with redaction                                   |
| Tests                   | Vitest, Supertest                                     | Fast, native TypeScript and ESM; HTTP tests without a network    |
| Lint and format         | ESLint (typescript-eslint, type-checked) and Prettier | Standard tooling                                                 |
| Monorepo                | npm workspaces                                        | No extra tool to install                                         |
| Development environment | Docker Compose                                        | The same Node.js version for every contributor                   |

The reasoning behind each decision is recorded in [BRAIN.md](BRAIN.md).
