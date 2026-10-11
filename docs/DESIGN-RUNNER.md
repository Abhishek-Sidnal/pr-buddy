# Design: runner mode

How PR Buddy can review a pull request with the whole repository in view, without ever holding
a customer's code. Decisions are in [BRAIN.md](BRAIN.md) (D-096 to D-104); threats and controls
in [SECURITY.md](SECURITY.md), section 6G.

**Status: proposed.** Nothing here is built. Section 13 lists the decisions that are still the
maintainer's to confirm.

## 1. The problem

The hosted service sees a pull request's diff and nothing else. It cannot follow a call into
another file, notice a broken caller, or tell that a helper already exists. Giving it more would
mean cloning customers' repositories onto the operator's server and letting a model search
them: the operator would hold source code, need a sandbox, and need far larger machines.

## 2. The idea

Run the deep review **where the code already is**: in the repository's own CI, as a GitHub
Action.

```
                     hosted mode (today)                    runner mode (this design)

 runs on             the operator's server                  the repository's CI runner
 sees                the diff                               the whole checkout
 AI key              stored encrypted by the service        a secret of the repository
 compute             the operator's                         the repository's Actions minutes
 code leaves for     the AI provider only                   the AI provider only
```

In runner mode the operator's server never receives code. At most it receives the same record
it stores today: identifiers, findings, counts, timings and token use.

The two modes are alternatives for a repository, not layers: a repository in runner mode is not
also reviewed by the hosted service (section 10).

## 3. What a run does

```
pull_request event in the repository's CI
  │
  ├─ 1 gates            no model cost: closed or draft, commit already reviewed,
  │                     too many files, a re-push that changed too little
  ├─ 2 collect          the diff against the base, the changed files, the config at the BASE commit
  ├─ 3 rules            the same deterministic rules as the hosted service (review-engine)
  ├─ 4 AI review        depth follows size; read-only tools over the checkout (sections 5, 6)
  ├─ 5 filter           code decides what is published (section 7)
  ├─ 6 publish          one summary comment, optionally line comments (section 8)
  └─ 7 report           tokens and cost to the job summary; optionally a record to a
                        PR Buddy service (section 9)
```

Nothing from the pull request is executed: no install, no build, no tests. The Action's own code
comes from PR Buddy's repository at a pinned version, never from the pull request.

## 4. Gates

Each is checked before any request to a model, and each ends the run with a line in the job
summary that says why.

| Gate          | Stops when                                                                        |
| ------------- | --------------------------------------------------------------------------------- |
| State         | The pull request is closed, merged or a draft                                     |
| Same commit   | The newest PR Buddy comment already names this head commit                        |
| Size          | More files changed than `maxFiles` (default 80): rules still run, AI does not     |
| Small re-push | A push after a review changed fewer code lines than `minRepushLines` (default 50) |
| No key        | No AI key is available (fork pull requests, section 11): rules only               |

## 5. What the model may see, and how

The model starts from the diff and may ask for more through three tools. They are implemented
by the runner, not by a vendor's toolkit (D-097).

| Tool         | Returns                                           | Limits                        |
| ------------ | ------------------------------------------------- | ----------------------------- |
| `read_file`  | Lines of one file in the checkout                 | a line range; a size cap      |
| `search`     | Lines matching a plain string, with file and line | a cap on matches; no patterns |
| `list_files` | Paths under a folder                              | a cap on entries              |

- **Read only.** No tool writes, runs anything or reaches the network.
- **Confined.** A path is resolved and must stay inside the checkout; a symbolic link that
  leaves it is refused.
- **Credential files are never read,** by the same patterns the hosted service uses to keep
  them out of a prompt, whatever the model asks.
- **`search` takes a plain string,** not a regular expression: the pull request's author chooses
  what the model reads, and a pattern is a way to hang the run (D-011).
- **Everything read is recorded:** which file, which lines. Section 7 uses that record.
- **Bounded.** A review may take at most a fixed number of steps and tokens (section 12). When
  either runs out, what has been found so far is filtered and published, and the comment says
  that the review stopped early.

Text from the pull request and from the repository is data. If it addresses the model, that is
something to report, not to obey. This matters more here than in hosted mode, because the model
now chooses what to read.

## 6. Depth follows size

| Change                                                       | Review                               |
| ------------------------------------------------------------ | ------------------------------------ |
| Documentation only, or small (≤ 150 code lines in ≤ 6 files) | One pass: a single reviewer          |
| Anything larger                                              | Specialists in parallel, then a lead |

- **Specialists** each look for one kind of problem: defects, security, and the repository's own
  written rules. Each returns candidates.
- **The lead** takes every candidate, reads the code it points at, tries to disprove it, and
  keeps or drops it.

Both shapes return the same structured findings. Which shape ran is recorded and shown.

## 7. Code decides what is published

The model's output is input to a filter, as in hosted mode (D-043), with more to check:

1. **Shape.** Each finding must match the schema or it is dropped.
2. **Location.** A file and line must exist; a line comment must be on a line of the diff.
3. **Read evidence.** A finding must point at code the reviewer actually read in this run, by
   the record of section 5. A claim about a file nobody opened is dropped (D-099).
4. **Lead's decision.** In the larger shape, only what the lead kept survives.
5. **Duplicates** of a rule finding or of each other are dropped.
6. **Limits.** At most a fixed number of findings and of line comments; the rest are counted.

What does not change from hosted mode: the model sets no rule ID, cannot report `critical`,
and its findings are labelled as AI and kept apart from rule findings.

PR Buddy still never approves, requests changes or blocks (D-100). The comment states what was
found and how many findings a person should look at. It is a comment, not a verdict.

## 8. What is published

- **The summary comment,** created or updated as today, with: the rule findings; the AI
  findings; which review shape ran; whether it stopped early; tokens used.
- **Line comments for AI findings** only when the repository turns them on, only for findings
  that passed every check of section 7, and at most a fixed number (D-101). They carry the same
  "AI, not a rule" label.
- **On a re-review,** earlier AI findings are classified as fixed, still open or withdrawn, and
  the summary lists them. An open one is not posted again as a new comment.

Comments are posted with the workflow's own token and so appear as GitHub Actions, not as the
PR Buddy app (D-102). Only comments carrying PR Buddy's marker and written by that identity are
ever updated or deleted (D-039).

## 9. Reporting to a PR Buddy service (optional)

A repository can send each run's record to a PR Buddy service, so that runner reviews appear in
the same dashboard, with history and usage.

- **Who is calling is proven by GitHub, not by a shared secret.** The run asks GitHub for a
  signed identity token for that service. The service checks the signature against GitHub's
  published keys and reads from it which repository and run this is (D-103).
- **What is sent** is what the service stores today and nothing more: identifiers, findings,
  counts, timings, and now token use per stage. No code, no titles, no model text beyond the
  findings (D-031, D-046).
- **A record is accepted** only for a repository of an installation the service knows.
- Without this, the runner is complete on its own: the job summary holds tokens and cost.

This is also where the usage pages come from: tokens by day and week, by repository and model,
and an estimated cost from a price the installation's owner sets.

## 10. Choosing a mode

In `.github/pr-buddy.json`, read at the base commit as always:

```json
{ "review": { "mode": "runner" } }
```

- `hosted` (the default): the service reviews, from the diff.
- `runner`: the service skips the repository and records why; the Action reviews.

The Action refuses to run when the base commit does not say `runner`, so a repository is never
reviewed twice, and a pull request cannot switch its own mode.

## 11. Keys, forks and what CI makes dangerous

- **The AI key is a secret of the repository or organisation,** passed to the Action. It is not
  fetched from the service: a stored key is never returned by any route (D-073, D-104).
- **Pull requests from forks get no secrets** from GitHub. The Action then runs the rules only
  and writes to the job summary. It never asks for the `pull_request_target` trigger, which
  would hand secrets to code from a stranger.
- **The workflow's permissions** are the least that works: read contents, write pull requests,
  and an identity token only if section 9 is used.
- **The key is never a tool's input or output.** Tools cannot read the environment.

## 12. Limits and cost

| Limit                   | Default                            |
| ----------------------- | ---------------------------------- |
| Files in a pull request | 80; beyond that, rules only        |
| Steps per review        | fixed, per reviewer                |
| Tokens per review       | a ceiling the repository can lower |
| Findings published      | fixed; the rest are counted        |
| AI line comments        | fixed, and off unless turned on    |

The ceiling is in tokens, which every provider reports, not in money, which depends on a price
PR Buddy does not know. Cost is an estimate shown beside it when a price is configured.

Where a provider supports it, the fixed part of a request (instructions and the repository's
rules) is marked for caching, and cache reads and writes are counted separately.

## 13. Decisions to confirm

| #   | Question                                                        | Proposed                                            |
| --- | --------------------------------------------------------------- | --------------------------------------------------- |
| 1   | Own tool loop over each provider's API, or a vendor's agent kit | Own loop: every provider, no new dependency (D-097) |
| 2   | May AI findings be line comments in runner mode                 | Yes, opt-in, verified ones only, capped (D-101)     |
| 3   | Whose name is on the comments                                   | The workflow's, at first (D-102)                    |
| 4   | Where the AI key lives in runner mode                           | A repository secret (D-104)                         |
| 5   | The repository must be public for others to use the Action      | Yes, before part 1 is useful to anyone else         |

## 14. Parts

| Part | Delivers                                                                          |
| ---- | --------------------------------------------------------------------------------- |
| 1    | The Action: gates, rules, the summary comment, the mode switch. No AI             |
| 2    | Tool use for the providers; the read-only tools; one-pass deep review; the filter |
| 3    | Depth by size: specialists and a lead. Re-reviews that track earlier findings     |
| 4    | Reporting to a service; tokens, cost and usage in the dashboard                   |
| 5    | AI line comments and suggested changes                                            |
| 6    | Notifications to chat, and a measure of how often findings are acted on           |

Each part is usable on its own, and each is verified on a real repository before the next.

## 15. What this does not do

- Run the repository's linters or tests. That means executing code from a pull request; even on
  the repository's own runner it deserves a design of its own.
- Keep a memory of past pull requests or team feedback.
- Review across repositories. A checkout is one repository.
- Work on a runner without a checkout, or on other code hosts.
