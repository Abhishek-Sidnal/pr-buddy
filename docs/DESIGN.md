# PR Buddy — Review Engine Design

Detailed design of `@pr-buddy/review-engine`. For the module map see
[ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Public API

```ts
import { createReviewEngine } from "@pr-buddy/review-engine";

const engine = createReviewEngine({ config }); // throws ConfigurationError
const result = await engine.review(context); // rejects with InvalidContextError
```

| Export                                                    | Purpose                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `createReviewEngine(options)`                             | Build an engine from a registry and a configuration                         |
| `RuleRegistry`, `createBuiltinRegistry()`, `builtinRules` | Manage the set of rules                                                     |
| `defineRule(rule)`                                        | Declare a rule with typed options                                           |
| `parseReviewContext(input)`                               | Validate review input on its own                                            |
| `parsePatch(patch)`                                       | Parse a unified-diff patch into hunks                                       |
| Schemas and types                                         | `reviewContextSchema`, `findingSchema`, `engineConfigSchema`, `Severity`, … |
| Errors                                                    | `ConfigurationError`, `InvalidContextError`, `RuleDefinitionError`          |

`config` and `context` are typed `unknown` because they come from outside the engine.

## 2. Data contracts

### 2.1 ReviewContext (input)

```ts
{
  pullRequest: {
    number: number;        // positive integer
    title: string;
    body: string | null;   // null when the PR has no description
    baseSha: string;       // full commit SHA
    headSha: string;       // full commit SHA
  },
  files: ChangedFile[]     // may be empty
}
```

```ts
ChangedFile {
  path: string;            // repository-relative, forward slashes
  status: "added" | "modified" | "removed" | "renamed" | "copied";
  previousPath?: string;   // required for renamed and copied, forbidden otherwise
  additions: number;
  deletions: number;
  patch?: string;          // absent for binary files and files too large to diff
}
```

Validation beyond types:

- Unknown fields are rejected.
- Paths must be relative, use `/`, and contain no `.` or `..` segments, empty segments,
  backslashes or control characters.
- A path may appear only once in `files`.
- Sizes are bounded by the limits in section 8.

### 2.2 ReviewFinding (output)

```ts
{
  ruleId: string;          // stamped by the engine
  severity: Severity;      // "low" | "medium" | "high" | "critical"
  confidence: number;      // 0 to 1
  message: string;
  evidence: { label: string; value: string }[];   // at least one entry
  filePath?: string;       // only if the file is in the diff
  line?: number;           // only if verified against the patch
  suggestion?: string;
}
```

### 2.3 ReviewResult (output)

```ts
{
  pullRequest: { number, baseSha, headSha };  // what was reviewed
  findings: ReviewFinding[];
  rules: RuleExecution[];                     // one per registered rule
  diagnostics: Diagnostic[];                  // what the engine corrected or rejected
  summary: { total, bySeverity, highestSeverity };
}
```

`RuleExecution.status` is `completed`, `disabled` or `failed`. A failed execution carries an error
message. That message is for operators and logs; integrations must not publish it to a pull
request.

## 3. Rule contract

```ts
export const exampleRule = defineRule({
  id: "example-rule", // kebab-case, unique
  version: "1.0.0", // bump when behaviour changes
  description: "What the rule reports.",
  defaultSeverity: "low",
  optionsSchema: z.strictObject({ limit: z.number().int().min(1).default(10) }),
  run(context, options) {
    return []; // finding drafts
  },
});
```

A rule returns **drafts**. A draft has a message and evidence, and may have a confidence, file,
line, suggestion and a severity. The engine adds the rule ID and resolves the severity, so a rule
cannot report under another rule's name.

Rules must be pure functions of `context` and `options`. They may be synchronous or asynchronous.

## 4. Configuration

```json
{
  "rules": {
    "pr-description": { "options": { "minLength": 50 } },
    "max-changed-files": { "severity": "high", "options": { "maxFiles": 20 } },
    "missing-test-changes": { "enabled": false }
  }
}
```

| Field      | Meaning                                               | Default                      |
| ---------- | ----------------------------------------------------- | ---------------------------- |
| `enabled`  | Whether the rule runs                                 | `true`                       |
| `severity` | Severity for every finding of the rule                | the rule's `defaultSeverity` |
| `options`  | Rule-specific options, validated by the rule's schema | the schema's defaults        |

Resolution rules:

- A missing configuration means every rule runs with its defaults.
- A setting for an unknown rule ID is an error, so a typo cannot silently disable a check.
- Options are validated for disabled rules too, so enabling a rule later cannot surprise.
- All problems are collected and reported in one `ConfigurationError`.

Severity precedence, highest first: configuration `severity` → the draft's `severity` → the rule's
`defaultSeverity`.

The engine accepts a plain object. Reading a file such as `.prbuddy.yml` is the integration's job;
see decision D-006 in [BRAIN.md](BRAIN.md).

## 5. Finding validation

### 5.1 Schema

Each draft is parsed with the draft schema. An invalid draft is dropped and a `FINDING_REJECTED`
diagnostic is recorded. At most `MAX_FINDINGS_PER_RULE` drafts are accepted from one rule; the
rest are dropped with a `FINDINGS_TRUNCATED` diagnostic.

### 5.2 Location

| Draft has                 | Condition                                     | Outcome                       |
| ------------------------- | --------------------------------------------- | ----------------------------- |
| `filePath`                | File is not in the diff                       | `filePath` and `line` removed |
| `line` without `filePath` | —                                             | `line` removed                |
| `line`                    | File was removed                              | `line` removed                |
| `line`                    | File has no patch                             | `line` removed                |
| `line`                    | Line is not on the new side of the patch      | `line` removed                |
| `line`                    | Line is an added or context line in the patch | kept                          |

Every removal records a `LOCATION_REMOVED` diagnostic. The finding itself is kept, so an
integration can still report it in the review summary.

### 5.3 Patch parsing

`parsePatch` reads hunk headers of the form `@@ -a,b +c,d @@` and walks the lines that follow,
using the header's counts as bounds. Added (`+`) and context (` `) lines are numbered on the new
side; removed (`-`) lines and the `\ No newline at end of file` marker are not. Text that is not
part of a hunk is ignored, and a final newline is not a line.

Each hunk records whether it is **well-formed**: it contains exactly the number of old-side and
new-side lines its header declares, no fewer and no more. Only well-formed hunks can verify a
location. A hunk that is cut short or carries extra lines contributes nothing, so a malformed
patch yields fewer verifiable lines rather than wrong ones.

## 6. Error handling

| Situation                               | Behaviour                                                              |
| --------------------------------------- | ---------------------------------------------------------------------- |
| Invalid configuration                   | `createReviewEngine` throws `ConfigurationError` listing every issue   |
| Invalid rule definition or duplicate ID | `RuleRegistry.register` throws `RuleDefinitionError`                   |
| Invalid review input                    | `engine.review` rejects with `InvalidContextError` listing every issue |
| A rule throws or times out              | Recorded as `failed`; other rules still report                         |
| A rule returns invalid drafts           | Drafts dropped, diagnostics recorded                                   |

Error messages name the field and the constraint. They do not echo input values, which may be
large or sensitive.

## 7. Built-in rules

Full reference: [RULES.md](RULES.md).

| Rule                   | Reports when                                                     | Default severity | Confidence |
| ---------------------- | ---------------------------------------------------------------- | ---------------- | ---------- |
| `pr-description`       | The description has fewer meaningful characters than `minLength` | low              | 1          |
| `max-changed-files`    | Counted files exceed `maxFiles`                                  | medium           | 1          |
| `missing-test-changes` | Source files changed and no test file changed                    | low              | 0.6        |

`missing-test-changes` is a heuristic. Its message says that no test files changed, states that
existing tests may already cover the change, and reports a confidence below 1.

## 8. Limits

Defined in `src/limits.ts`.

| Limit                       | Value                   | Reason                                          |
| --------------------------- | ----------------------- | ----------------------------------------------- |
| Files per review            | 3,000                   | GitHub's maximum for a pull request's file list |
| Path length                 | 1,024                   | Bounds matching cost                            |
| Patch length per file       | 1,000,000 characters    | Bounds parsing cost                             |
| Patch length per review     | 10,000,000 characters   | Bounds memory across up to 3,000 files          |
| PR body length              | 262,144 characters      | Above GitHub's own limit                        |
| PR title length             | 1,024 characters        | —                                               |
| Glob patterns per option    | 100                     | Bounds matching cost                            |
| Glob pattern length         | 256                     | Bounds matching cost                            |
| Brace combinations per glob | 64                      | `{a,b}{c,d}…` cannot multiply without limit     |
| Validation issue length     | 300 characters          | Issues can quote field names from the input     |
| Findings per rule           | 100                     | A rule cannot flood a review                    |
| Rule time limit             | 5,000 ms (configurable) | A stuck asynchronous rule cannot block a review |

## 9. Determinism

- Findings are sorted by severity (highest first), then file, line, rule ID and message.
- Identical findings from one rule are merged.
- Rules receive a frozen context and frozen options.
- The only non-deterministic output is `RuleExecution.durationMs`.

## 10. Testing strategy

| Layer       | Location                     | What it proves                                                       |
| ----------- | ---------------------------- | -------------------------------------------------------------------- |
| Unit        | `tests/unit/` mirrors `src/` | Each module in isolation, including malformed input                  |
| Rule        | `tests/unit/rules/`          | Positive, negative and edge cases per rule                           |
| Integration | `tests/integration/`         | The whole engine against JSON fixtures and the example configuration |

Fixtures in `tests/fixtures/contexts/` are shaped like normalised GitHub pull request data and
cover added, removed, renamed, mixed and empty diffs. Builders in `tests/helpers/` create small
contexts for unit tests.
