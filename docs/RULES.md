# PR Buddy — Rule Reference

The deterministic rules built into `@pr-buddy/review-engine`. Every rule can be disabled, given a
different severity and configured; see [Configuration](#configuration).

| Rule                                                | Reports                                                    | Default severity |
| --------------------------------------------------- | ---------------------------------------------------------- | ---------------- |
| [`pr-description`](#pr-description)                 | A missing or very short description                        | low              |
| [`max-changed-files`](#max-changed-files)           | More changed files than the configured maximum             | medium           |
| [`missing-test-changes`](#missing-test-changes)     | Source files edited without any test file being edited     | low              |
| [`max-changed-lines`](#max-changed-lines)           | More added and removed lines than the configured maximum   | medium           |
| [`debug-statements`](#debug-statements)             | `console.log`, `debugger` and similar on added lines       | low              |
| [`credential-files`](#credential-files)             | Files whose names say they usually hold credentials        | high             |
| [`sensitive-file-changes`](#sensitive-file-changes) | Changes to files that control builds, deployment or review | medium           |

`debug-statements` points at the line of each statement and `credential-files` at each file. On
GitHub, a finding with a line is also posted as a comment on that line. The other rules describe
the pull request as a whole.

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

### Reporting thresholds

A repository can hide findings it does not want to see:

```json
{
  "report": {
    "minSeverity": "medium",
    "minConfidence": 0.7
  }
}
```

| Field           | Values                                      | Default | Meaning                                |
| --------------- | ------------------------------------------- | ------- | -------------------------------------- |
| `minSeverity`   | `"low"`, `"medium"`, `"high"`, `"critical"` | `"low"` | Findings less severe are not reported  |
| `minConfidence` | 0 to 1                                      | `0`     | Findings less certain are not reported |

Both limits are inclusive. Rules still run; only reporting changes. The comment states how many
findings were hidden, so a reader can tell that something was left out. A severity set for a rule
in `rules` is applied before the threshold.

### AI review

```json
{
  "ai": { "enabled": true }
}
```

Off by default. When it is on **and** the operator of the service has configured a model provider,
the pull request's title, description and visible diff lines are sent to that provider, and its
suggestions appear in their own section of the comment. They are reported under the ID
`ai-review` with a fixed confidence of 0.5, so `report.minConfidence` above 0.5 hides them. What
is sent, what never is, and how replies are checked: [DESIGN-AI.md](DESIGN-AI.md).

No provider is included yet, so today this setting has no effect.

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

## max-changed-lines

Reports a pull request that adds and removes more lines than the configured maximum. It
complements `max-changed-files`: one file with two thousand changed lines is as hard to review as
forty small edits.

**How it decides.** The added and removed lines of every changed file are summed, leaving out
files that match an `exclude` pattern.

| Option     | Type               | Default                   | Meaning                                 |
| ---------- | ------------------ | ------------------------- | --------------------------------------- |
| `maxLines` | integer, 1 or more | `1000`                    | Largest line count that is not reported |
| `exclude`  | glob patterns      | package-manager lockfiles | Files whose lines do not count          |

**Limitations.** Line counts come from GitHub and include moved code and reformatting.

## debug-statements

Reports debugging statements on lines a pull request adds, and points at each line.

**How it decides.** For each added line of a checked file, it looks for a call to one of the
configured `console` methods, or a `debugger` statement on a line of its own. Lines that start as
a comment, and lines longer than 1,000 characters, are skipped. Lines that were only moved or
left unchanged are not looked at.

| Option           | Type          | Default                                 | Meaning                        |
| ---------------- | ------------- | --------------------------------------- | ------------------------------ |
| `consoleMethods` | method names  | `log`, `debug`, `trace`, `table`, `dir` | `console` methods that count   |
| `include`        | glob patterns | JavaScript and TypeScript files         | Files that are checked         |
| `exclude`        | glob patterns | test files                              | Files that are not checked     |
| `maxFindings`    | integer, 1–50 | `10`                                    | Statements reported one by one |

`console.warn` and `console.error` are not reported by default. Statements beyond `maxFindings`
are counted in one further finding.

**Confidence 0.9.** The rule matches text. A `console.log(` inside a string or a template would
be reported too.

**The line is not quoted.** The finding names the statement and its location. Findings are stored
and published; source code is not.

**Limitations.** JavaScript and TypeScript only. A command-line tool that prints with
`console.log` on purpose will be reported: exclude its files or change `consoleMethods`.

## credential-files

Reports added or edited files whose names say they usually hold credentials.

**How it decides.** A file that still exists after the change is reported if its path matches one
of `patterns` and none of `allow`. Only the name is checked. Removing such a file is not reported.

| Option        | Type          | Default                                                                                                                                                       |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patterns`    | glob patterns | `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `.netrc`, `.pgpass`, in any folder |
| `allow`       | glob patterns | `.env.example`, `.env.sample`, `.env.template`, `.env.dist`                                                                                                   |
| `maxFindings` | integer, 1–50 | `10`                                                                                                                                                          |

**Confidence 0.8.** A name suggests what a file holds; it does not prove it.

**Limitations.** This is not a secret scanner. It does not read file contents, so a key pasted
into source code is not found, and a harmless file with an alarming name is reported. Use a
dedicated secret scanner alongside it.

## sensitive-file-changes

Reports changes to files that control how the project is built, deployed, installed or reviewed.
It states a fact, that these files changed; whether the change is right is for a person to judge.

**How it decides.** Any changed file, including a removed one, that matches `patterns`. All
matches are reported together in one finding.

| Option     | Type                        | Default                                                                                                                         |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `patterns` | glob patterns, at least one | CI workflows and actions under `.github`, `dependabot.yml`, `pr-buddy.json`, `CODEOWNERS`, Dockerfiles, Compose files, `.npmrc` |

**Limitations.** The list is a starting point. Add your own infrastructure files, such as
Terraform or Kubernetes manifests.

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
