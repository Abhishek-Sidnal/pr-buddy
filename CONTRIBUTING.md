# Contributing to PR Buddy

Thank you for helping. Read [docs/CONTEXT.md](docs/CONTEXT.md) first; it explains where things are
and which rules must not be broken.

## Setup

You need Docker. Then:

```bash
docker compose run --rm dev npm install
```

```bash
docker compose run --rm dev npm run check
```

`npm run check` is what CI runs. A change is ready when it passes.

## Workflow

1. Open an issue before a large change, so the approach can be agreed first.
2. Create a branch from `main`.
3. Make the change, with tests.
4. Run `npm run check`.
5. Update the documents the change affects (see below).
6. Open a pull request and fill in the template.

## Coding rules

### Architecture

- The review engine performs no I/O and never executes code from a reviewed repository. ESLint
  enforces this; do not suppress it.
- Modules depend downwards only: `engine → config → rules → findings → context → utils`. See
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Other packages import the engine from its root, never from a file inside it.
- Build only what the current milestone needs.

### TypeScript

- Strict mode with the settings in `tsconfig.base.json`. No `any`, no non-null assertions (`!`).
- Anything that crosses the public API is typed `unknown` and parsed with a Zod schema.
- Infer types from schemas with `z.infer`. Do not write a second definition by hand.
- Named exports only. Relative imports end in `.js`.
- Prefer `readonly` data and pure functions.

### Naming

| Thing     | Convention                         | Example                     |
| --------- | ---------------------------------- | --------------------------- |
| Files     | kebab-case                         | `finding-location.ts`       |
| Rules     | `<rule-id>.rule.ts`                | `max-changed-files.rule.ts` |
| Schemas   | `<name>.schema.ts`, `<name>Schema` | `findingSchema`             |
| Rule IDs  | kebab-case                         | `missing-test-changes`      |
| Types     | PascalCase                         | `ReviewFinding`             |
| Constants | UPPER_SNAKE_CASE                   | `MAX_FILES`                 |

### Reuse

- Before writing a helper, look in `src/utils/`. Add a helper there when two modules need it.
- Sizes and time limits are constants in `src/limits.ts`, never literals in other files.
- Keep functions small and single-purpose. Avoid abstractions that have one user.

### Security

- Treat pull request content, configuration and rule output as untrusted.
- Bound every loop and regular expression that touches untrusted input. Prefer `indexOf` scans to
  regular expressions with nested or adjacent quantifiers.
- Error messages name the field and the constraint. They do not repeat input values.
- Never commit credentials. Fixtures use invented code only.
- Adding a dependency needs a reason in the pull request. Prefer none.

### Comments

Comment why, not what. A comment is worth writing when it records a constraint or a reason the
code cannot show.

## Tests

- Tests live in `tests/unit/<module>/` and mirror `src/`. Whole-engine tests live in
  `tests/integration/`.
- Every rule needs positive, negative, edge-case and invalid-option tests.
- Every schema needs malformed-input tests.
- Use the builders in `tests/helpers/builders.ts` for small inputs and the JSON fixtures in
  `tests/fixtures/` for realistic ones.
- Coverage thresholds are set in `vitest.config.ts`. Do not lower them to make a change pass.

## Adding a rule

1. Create `packages/review-engine/src/rules/<rule-id>.rule.ts` using `defineRule`.
2. Add it to `builtinRules` in `rules/builtin.ts` and export it from `src/index.ts`.
3. Add `tests/unit/rules/<rule-id>.rule.test.ts`.
4. Document it in [docs/RULES.md](docs/RULES.md), including its limitations.
5. Word the finding so it claims no more than its evidence shows.

## Documents to keep current

| When you…                         | Update                                                  |
| --------------------------------- | ------------------------------------------------------- |
| Finish or start a task            | [docs/TRACKER.md](docs/TRACKER.md)                      |
| Make a design decision            | [docs/BRAIN.md](docs/BRAIN.md)                          |
| Change a rule's behaviour         | [docs/RULES.md](docs/RULES.md) and the rule's `version` |
| Change a data contract or a limit | [docs/DESIGN.md](docs/DESIGN.md)                        |
| Add or move a module              | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)            |
| Add a control or find a threat    | [docs/SECURITY.md](docs/SECURITY.md)                    |

## Commit messages

Use the imperative mood and say why when it is not obvious: `Reject duplicate file paths in the
review context`.

## Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Changelog and pins

A change that a user or operator can notice gets a line in `CHANGELOG.md` under "Unreleased". A
change to settings, defaults or the database also gets an upgrade note.

GitHub Actions are referenced by a full commit SHA and container images by a `sha256` digest;
`sh scripts/check-pins.sh` fails otherwise, and runs in CI. How a release is made is in
[docs/RELEASING.md](docs/RELEASING.md).
