# PR Buddy — Rule Reference

The deterministic rules built into `@pr-buddy/review-engine`. Every rule can be disabled, given a
different severity and configured; see [Configuration](#configuration).

| Rule                                            | Reports                                                | Default severity |
| ----------------------------------------------- | ------------------------------------------------------ | ---------------- |
| [`pr-description`](#pr-description)             | A missing or very short description                    | low              |
| [`max-changed-files`](#max-changed-files)       | More changed files than the configured maximum         | medium           |
| [`missing-test-changes`](#missing-test-changes) | Source files edited without any test file being edited | low              |

None of these rules points at a file or line: each describes the pull request as a whole.

## Configuration

```json
{
  "rules": {
    "<rule-id>": {
      "enabled": true,
      "severity": "medium",
      "options": {}
    }
  }
}
```

| Field      | Values                                      | Default                 |
| ---------- | ------------------------------------------- | ----------------------- |
| `enabled`  | `true`, `false`                             | `true`                  |
| `severity` | `"low"`, `"medium"`, `"high"`, `"critical"` | the rule's own default  |
| `options`  | Depends on the rule                         | the rule's own defaults |

Unknown rule IDs, unknown fields and invalid option values are errors. A complete example is in
[`examples/prbuddy.config.json`](../examples/prbuddy.config.json).

### Glob patterns

Options that select files take glob patterns matched against the path from the repository root,
for example `src/services/user.service.ts`.

| Syntax  | Matches                                               | Example                   |
| ------- | ----------------------------------------------------- | ------------------------- |
| `*`     | Any characters within one folder or file name         | `src/*.ts`                |
| `?`     | Exactly one character within one folder or file name  | `file-?.ts`               |
| `**`    | Zero or more folders, when it is a whole path segment | `**/*.test.ts`, `docs/**` |
| `{a,b}` | Either alternative; groups can be nested              | `**/*.{ts,tsx}`           |

Everything else is literal, including `[`, `]`, `(`, `)` and `!`. Matching is case-sensitive, a
pattern must match the whole path, and `*` also matches names that start with a dot. There is no
escape character and no negation.

Limits: 100 patterns per option, 256 characters per pattern, and at most 64 combinations from the
brace groups of one pattern.

## pr-description

Reports a pull request whose description is missing or too short to explain the change.

**How it decides.** HTML comments and Markdown heading lines are removed from the description,
because they are usually an unfilled pull request template. Whitespace is collapsed. If fewer than
`minLength` characters remain, the rule reports.

| Option      | Type            | Default | Meaning                               |
| ----------- | --------------- | ------- | ------------------------------------- |
| `minLength` | integer, 1–5000 | `30`    | Fewest meaningful characters accepted |

**Example finding**

> The pull request description is too short to explain the change.
>
> - Description length: 7 characters, not counting headings and HTML comments
> - Configured minimum: 30 characters

**Limitations.** Length is a proxy for usefulness: thirty characters of filler pass. Template text
that is not a heading or a comment, such as checklist items, is counted as the author's own.

## max-changed-files

Reports a pull request that changes more files than the configured maximum. Large pull requests
are reviewed less carefully.

**How it decides.** Every changed file counts once, whatever its status, unless it matches an
`exclude` pattern.

| Option     | Type            | Default                   | Meaning                                 |
| ---------- | --------------- | ------------------------- | --------------------------------------- |
| `maxFiles` | integer, 1–3000 | `30`                      | Largest file count that is not reported |
| `exclude`  | glob patterns   | package-manager lockfiles | Files that do not count                 |

The default exclusions are `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`,
`pnpm-lock.yaml`, `bun.lock` and `bun.lockb` in any folder. Setting `exclude` replaces this list.

**Example finding**

> The pull request changes 42 files, more than the configured maximum of 30.
>
> - Changed files counted: 42
> - Configured maximum: 30
> - Files excluded from the count: 1

**Limitations.** File count ignores the size of each change: forty one-line edits are reported and
one two-thousand-line file is not.

## missing-test-changes

Reports a pull request that edits source files without editing any file that matches the
repository's test conventions.

**This is a signal, not proof.** Existing tests may already cover the change. The finding says so,
and it is reported with a confidence of 0.6 rather than 1.

**How it decides.**

1. Consider only files whose content was edited. Removed files, pure renames and mode-only changes
   are ignored.
2. If any of them matches `testPatterns`, report nothing.
3. Otherwise report if any of them matches `sourcePatterns` and does not match `ignorePatterns`.

| Option           | Type                        | Default                                                                                      |
| ---------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| `sourcePatterns` | glob patterns, at least one | JavaScript and TypeScript files                                                              |
| `testPatterns`   | glob patterns, at least one | `*.test.*` and `*.spec.*` script files; anything under `__tests__`, `test`, `tests` or `e2e` |
| `ignorePatterns` | glob patterns               | Type declarations (`*.d.ts`), `*.config.*` and `*.stories.*` script files                    |

"Script files" means the extensions `js`, `jsx`, `mjs`, `cjs`, `ts`, `tsx`, `mts` and `cts`.
Setting an option replaces its default list.

**Example finding**

> The pull request edits 2 source files but no test files. This is a signal, not proof: existing
> tests may already cover the change.
>
> - Edited source files: src/services/user.service.ts, src/routes/users.ts
> - Test file patterns checked: `**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}`, `**/__tests__/**`, `**/{test,tests,e2e}/**`

**Limitations.** The rule looks at file names only. It cannot tell whether an edited test
exercises the edited source, and one edited test file silences it for the whole pull request.

## Writing a rule

```ts
import { createBuiltinRegistry, createReviewEngine, defineRule } from "@pr-buddy/review-engine";
import { z } from "zod";

const noEnvFiles = defineRule({
  id: "no-env-files",
  version: "1.0.0",
  description: "Reports environment files that are part of a pull request.",
  defaultSeverity: "high",
  optionsSchema: z.strictObject({}),
  run: (context) =>
    context.files
      .filter((file) => file.status !== "removed" && file.path.endsWith(".env"))
      .map((file) => ({
        message: "An environment file is part of the pull request.",
        evidence: [{ label: "File", value: file.path }],
        filePath: file.path,
      })),
});

const engine = createReviewEngine({ registry: createBuiltinRegistry().register(noEnvFiles) });
```

Requirements for a rule:

- A pure function of `context` and `options`: no I/O, no shared state, nothing executed from the
  reviewed repository.
- At least one piece of evidence per finding.
- A `filePath` only for a changed file, and a `line` only for an added or unchanged line shown in
  that file's patch. The engine removes anything else.
- A message that claims no more than the evidence shows.
- Positive, negative and edge-case tests.
- A new `version` whenever behaviour changes.
