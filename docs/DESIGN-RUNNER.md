# Design: runner mode

How PR Buddy can review a pull request with the whole repository in view, without ever holding
a customer's code. Decisions are in [BRAIN.md](BRAIN.md) (D-096 to D-117); threats and controls
in [SECURITY.md](SECURITY.md), section 6G.

**Status on 2026-10-11: phase 1 is released in `v0.4.0`; phase 2 is built and has not passed its
gate.** All three changes of phase 2 exist and are tested: the tools, the loop with each
provider's adapter, and the reviewer with its filter, wired into the Action. **No real provider
has been asked and no real workflow has run it**; that is the gate (section 18). Phase 2 began
on the maintainer's instruction with two items of phase 1's gate still unverified (D-111). What
was tried is in [TRACKER.md](TRACKER.md). How to use the Action: [RUNNER.md](RUNNER.md).

## 1. The problem

The hosted service sees a pull request's diff and nothing else. It cannot follow a call into
another file, notice a broken caller, or tell that a helper already exists. Giving it more would
mean cloning customers' repositories onto the operator's server and letting a model search
them: the operator would hold source code, need a sandbox, and need far larger machines.

## 2. The answer, and what was decided

Run the deep review **where the code already is**: in the repository's own CI, as a GitHub
Action.

```
                     hosted mode (the default)              runner mode (opt-in)

 runs on             the operator's server                  the repository's CI runner
 sees                the diff                               the whole checkout
 AI key              stored encrypted by the service        a secret of the repository
 compute             the operator's                         the repository's Actions minutes
 code leaves for     the AI provider only                   the AI provider only
```

The two are **alternatives**. Runner mode is not a layer on top of hosted mode, and a
repository never gets both reviews for one event (section 4).

| #   | Decision                                                                                     | Record |
| --- | -------------------------------------------------------------------------------------------- | ------ |
| 1   | PR Buddy's own bounded tool loop over each provider's API. No vendor agent toolkit.          | D-097  |
| 2   | AI findings may be line comments in runner mode: off by default, verified ones only, capped. | D-101  |
| 3   | Comments are posted with the workflow's token and appear as GitHub Actions.                  | D-102  |
| 4   | The AI key is a repository or organisation Actions secret. The service never hands one out.  | D-104  |
| 5   | The Action is for the public, MIT-licensed repository, and is not called generally available | D-107  |
|     | until the checks of section 19 have been made.                                               |        |

Two more follow from the review of this design: dashboard reporting waits until the standalone
Action has proved itself (D-106), and suggested code changes are out of scope until designed
separately (D-108).

Nothing is taken from any other reviewer's source, prompts, rules or configuration. Runner mode
is written for PR Buddy from this design, on PR Buddy's own packages.

## 3. Trust boundaries

**Untrusted, always:** the checkout; the pull request's title, description, commits, file names
and contents; the repository's configuration as proposed by the pull request; every character
a model returns.

**Trusted:** the Action's own code, which comes from PR Buddy at a pinned release or commit and
never from the pull request; the configuration at the pull request's **base** commit; what
GitHub's API says about the pull request; the workflow's secrets.

```
 pull request (untrusted) ──► checkout ──► read-only tools ──► model (untrusted output)
                                                │                     │
            base commit (trusted) ──► config    │ record of what      ▼
                                                └─ was read ──► filter in code ──► comment
```

Prompts ask the model to behave. They are not the boundary. The boundary is code: what the
tools can do, what the filter lets through, and what the workflow's token may touch.

## 4. Choosing a mode, and never both

In `.github/pr-buddy.json`, read at the pull request's **base** commit and validated against
PR Buddy's configuration schema:

```json
{ "review": { "mode": "runner" } }
```

| What the base commit says    | The hosted service                                            | The Action             |
| ---------------------------- | ------------------------------------------------------------- | ---------------------- |
| No file, or no `review.mode` | reviews                                                       | refuses, and says why  |
| `"hosted"`                   | reviews                                                       | refuses, and says why  |
| `"runner"`                   | skips, and records the reason                                 | reviews                |
| A file that fails validation | reviews with defaults, as today, and says the file is invalid | refuses, and says why  |
| The file cannot be fetched   | fails the review, as today                                    | fails; no rules, no AI |

- Each row has **at most one** reviewer. An invalid file never activates both, and never
  activates runner mode.
- The Action reviews only on an explicit, valid `"runner"`. When it cannot establish the mode
  it does nothing that costs money or publishes anything, and fails visibly.
- A pull request cannot switch the mode for its own review, because its own copy of the file is
  never read.
- Neither side needs the other to be reachable. The Action works with no PR Buddy service,
  account or dashboard anywhere (D-105).

## 5. What a run does

```
pull_request event in the repository's CI
  │
  ├─ 1 mode             the configuration at the base commit must say "runner"
  ├─ 2 gates            no model cost (section 6)
  ├─ 3 collect          the changed files and their diffs
  ├─ 4 rules            the same deterministic rules as the hosted service
  ├─ 5 AI review        from phase 2: read-only tools over the checkout (sections 8, 9)
  ├─ 6 filter           code decides what is published (section 10)
  ├─ 7 publish          one summary comment; line comments if turned on (section 11)
  └─ 8 job summary      what was found, which gates stopped it, what failed, tokens used
```

Nothing from the pull request is executed: no package installation, build, test, linter, script
or binary. Those would need a security design of their own.

## 6. Gates

Each is checked before any request to a model. Each ends the run with a line in the job summary
that says why.

| Gate          | Stops when                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------ |
| State         | The pull request is closed, merged or a draft                                              |
| Same commit   | PR Buddy's summary comment already names this head commit                                  |
| Size          | More files or more diff than the limits allow: the rules run on what fits, AI does not run |
| Small re-push | A push after a review changed fewer code lines than the threshold: AI does not run (D-109) |
| No key        | No AI key is available, as for a fork's pull request: rules only                           |
| No checkout   | There is no checkout, or it is not at the head commit: rules only (section 8.1, D-112)     |

The gates on the pull request's state and on a repeated commit end the run. The gates on size
and on a small re-push end only the part that costs money: **the rules always run** on a pull
request that is open, ready and at a new commit. They are free, and a comment that kept a
finding the push had removed would be wrong (D-109). In phase 1, where no model is asked, a
small re-push is therefore measured and reported, and changes nothing else.

The "same commit" gate reads PR Buddy's own comment. A pull request with no findings has no
comment, so a second run for the same commit runs the rules again and still publishes nothing.

## 7. GitHub events and permissions

**Events:** `pull_request` with `opened`, `synchronize`, `reopened` and `ready_for_review`.
Never `pull_request_target`.

| Phase | Workflow permission    | Why                                                    |
| ----- | ---------------------- | ------------------------------------------------------ |
| 1     | `contents: read`       | Read `.github/pr-buddy.json` at the base commit        |
| 1     | `pull-requests: write` | Read the pull request and its files; write the comment |
| 2     | (none added)           | The checkout uses `contents: read`                     |
| 4     | `id-token: write`      | Only when reporting to a service is turned on          |

No other permission is asked for, and none is widened to make a fork's pull request work.

**Phase 1 needs no checkout.** The changed files and their diffs come from GitHub's API, as in
hosted mode, so no contributor code is on the runner at all. From phase 2 the head commit is
checked out for reading, without stored credentials, and still never executed. The workflow
does that with its own step (section 8.1); a repository that leaves the step out keeps the
rules-only review.

A workflow should also set a concurrency group per pull request, so that a newer push cancels
an older run instead of racing it to the comment.

## 8. The tools (from phase 2)

The model starts from the diff and may ask for more through three tools, implemented by the
runner in `apps/runner/src/tools`. The hosted service has no tools and is never given any
(D-114).

| Tool         | Returns                                             | Refuses                               |
| ------------ | --------------------------------------------------- | ------------------------------------- |
| `read_file`  | A range of lines of one file                        | Ranges and files over the size limits |
| `search`     | Lines containing a plain string, with file and line | Patterns; it is a literal string only |
| `list_files` | Paths under a folder                                | More entries than the limit           |

For **every** call, enforced in code:

- The path is resolved against the checkout's root. Anything that leaves it is refused,
  including through `..` and through a symbolic link.
- Credential and other sensitive files are refused, by one policy kept in one place and shared
  with the hosted reviewer.
- Limits apply per file, per response, to the total returned in a review, to the number of
  steps, to tokens, and to wall-clock time.
- The exact path and lines returned are recorded.
- There is no tool that writes, runs a process or opens a network connection, and no tool can
  read the environment.

When a limit is reached, the review stops, what was verified so far is published, and the
comment says that it stopped early.

### 8.1 The checkout

The workflow checks the repository out; the Action does not, and runs no `git`. Two things are
asked of that step:

```yaml
- uses: actions/checkout@<full commit SHA>
  with:
    ref: ${{ github.event.pull_request.head.sha }}
    persist-credentials: false
```

- **`ref` must be the head commit.** For a pull request GitHub checks out a merge commit by
  default. Its line numbers can differ from the head commit's, and the diff, the read record and
  every finding are in the head commit's numbers.
- **`persist-credentials: false`** keeps the workflow's token out of `.git/config`. The tools
  refuse everything under `.git` anyway.

The runner does not take this on trust. It reads `.git/HEAD` as a file and compares it with the
head commit GitHub's API reports. If there is no checkout, or it is at another commit, **no model
is asked**: the rules run as in phase 1 and the job summary says why (D-112).

### 8.2 How a path is checked

In this order, by `resolveInCheckout`:

1. Longer than 1,000 characters, or holding a NUL or a backslash: refused.
2. Starting with `/`, or with a `..` segment anywhere: refused. `..` is not resolved first.
3. Protected by name: refused. That is anything under a folder named `.git`, and every file the
   hosted reviewer never sends (`isNeverSentPath`: credential files other than templates, and
   lockfiles). Names are compared in lower case as well.
4. Not there: refused.
5. **A symbolic link, or a path through one: refused, wherever it points** (D-113). The path's
   real location must be the path itself.

A refusal is fixed text. It never repeats the path, and a tool that refuses records nothing.

`search` and `list_files` walk folders with the same checks: a link is never followed or opened,
`.git` is never entered, and a protected file is never read. `list_files` shows a protected
file's name, because a name is not its content; `read_file` then refuses it.

A file larger than 1 MiB, or holding a NUL byte, is not text for a review and is not read.

### 8.3 What counts as read

`read_file` records the lines it returned, and `search` the matching lines it returned.
`list_files` records nothing. A line is recorded only after the answer that carries it fitted in
the review's budget, so the record never runs ahead of what the model received. The lines of the
diff that the prompt carries are added to the same record in the change that builds the reviewer.

### 8.4 The loop

`runToolLoop`, in `packages/ai-reviewer`, holds the conversation. It knows no provider and no
tool: it is given both.

```
send the pull request ──► reply asks for tools? ──no──► that reply is the answer
        ▲                        │ yes
        │                 run each tool, in order
        └── answers ◄─────  (unknown tool, a tool that fails, too many: a refusal)
```

- **Steps.** At most 20 requests to the model. A reply may ask for several tools; 8 are served
  and the rest refused.
- **Tokens.** The provider's own counts are added up over the requests. At 400,000 the loop
  stops asking for tools. A provider that reports no counts cannot be limited this way; the
  limits on steps and on tool output still hold.
- **Time.** 4 minutes for everything. The request in flight is told to stop.
- **The closing request.** When steps, tokens or the tool budget run out, the model is asked
  once more, with a fixed sentence, for the answer it can give from what it has read. A tool
  request in that reply is ignored. So a limit costs depth, not the whole review (D-116).
- **When time runs out, or the provider fails or answers malformed,** there is no answer. The
  result says which, by a fixed word and the error's name; nothing of a reply or of an error's
  message is kept.
- **A tool cannot break the loop.** A tool that throws is reported to the model as failed, in
  fixed words. Its error is not passed on: it could quote a path.

The loop never rejects. What it returns is the model's last reply as text, which is untrusted
input for the filter of section 10, and counts: requests, tool calls, tokens, time.

## 9. Depth follows size (phase 3)

Phase 2 has one reviewer. Phase 3 adds a second shape:

| Change                       | Review                                              |
| ---------------------------- | --------------------------------------------------- |
| Documentation only, or small | One reviewer                                        |
| Anything larger              | Specialists for defects, security and the project's |
|                              | own conventions, then a lead                        |

The lead reads the code each candidate points at and tries to disprove it before keeping it.
Both shapes return the same structured findings and go through the same filter. Neither a
specialist's claim, an earlier AI finding, nor an instruction written in the repository can
bypass a check that code enforces.

## 10. Code decides what is published

1. **Shape.** A finding must match the schema or it is dropped.
2. **Location.** The file must exist in the repository and the line must be a real one.
3. **Read evidence.** The location must be in the record of what the reviewer read in this run.
   The model saying that it looked is not evidence (D-099).
4. **Lead's decision,** in the larger shape.
5. **Duplicates** of a rule finding, or of each other, are dropped.
6. **Limits** on findings and on line comments; the rest are counted.
7. **Safe rendering.** Text from a model is published as text, escaped like any text a
   contributor can choose.

As in hosted mode, the model never sets a rule ID, cannot report `critical`, and its findings
are labelled as AI and kept apart from rule findings.

As built in phase 2 (`reviewWithTools`, `toReadFindings`):

- A model is asked only when three things hold: `ai.enabled` at the base commit, a provider in
  the workflow's inputs, and a checkout at the head commit (D-117). The gates of section 6 are
  checked in a fixed order before the provider is even constructed.
- The lines of the diff that the first message carries are recorded as read; so is every line a
  tool returns. A suggestion with a file and a line needs that line in the record; one with a
  file alone needs any line of that file; one with neither concerns the whole pull request.
- A suggestion at the file and line of a rule's finding is dropped: the rule already said it.
- What was dropped is counted in the job summary. Why a suggestion was dropped is not
  published: it would repeat text a model wrote about code it did not read.
- AI suggestions alone are enough for a comment to be posted.

PR Buddy does not approve, request changes, block or merge (D-100). It publishes findings for
people to assess.

## 11. What is published, and exactly once

- **The summary comment.** One per pull request. The Action finds the comment that carries PR
  Buddy's marker **and** was written by the workflow's own identity, and updates it; otherwise
  it creates one. It never edits a person's comment or another automation's, whatever that
  comment contains.
- **The marker names the head commit** that was reviewed. That is what the "same commit" gate
  reads, so running twice for one commit publishes once.
- **Line comments for AI findings (phase 5)** are off unless the repository turns them on. Only
  findings that passed every check of section 10, on a line of the diff, up to a limit. A
  stable fingerprint per finding keeps a re-run from notifying twice. Only line comments the
  runner's own identity created are reconciled.
- **On a re-review (phase 3),** earlier AI findings are classified as fixed, still open or
  withdrawn. A finding that is still open is not posted again.
- **Suggested code changes** are not published. They need their own design for formatting,
  validation against the diff, and idempotent publication (D-108).

Comments appear as GitHub Actions (D-102). A PR Buddy identity for runner mode is not part of
this work.

## 12. Keys and forks

- The AI key is passed to the Action from a repository or organisation secret. The runner never
  asks a PR Buddy service for a key, and the service has no route that would return one.
- The key is never logged, never part of a tool's input or output, and never in a comment, a
  finding, the job summary or an artifact.
- **A fork's pull request receives no secrets from GitHub.** The Action then runs the rules only.
  If the read-only token GitHub gives a fork cannot write a comment, the result goes to the job
  summary alone. Nothing is loosened to change that.

## 13. Limits

Named constants, as everywhere in PR Buddy (`apps/runner/src/limits.ts`). Each gets its number
in the phase that builds it.

| Limit                                  | Value         | When it is reached                             |
| -------------------------------------- | ------------- | ---------------------------------------------- |
| Files and diff size                    | as hosted     | Rules run on what fits; AI does not run        |
| Small re-push threshold                | 50 code lines | AI does not run; the rules do (D-109)          |
| A path given to a tool                 | 1,000 chars   | Refused                                        |
| A file a tool reads                    | 1 MiB         | Refused; `search` passes over it               |
| Lines per `read_file` call             | 400           | The rest needs another call                    |
| Characters kept of one line            | 500           | The line is cut, with a mark                   |
| One tool answer                        | 40,000 chars  | Fewer lines are returned, and the answer says  |
| All tool answers of one review         | 400,000 chars | The call is refused and the review stops early |
| `search`: text length                  | 3 to 200      | Refused                                        |
| `search`: matches, files, bytes, names | 50, 5,000,    | The search stops and says there may be more    |
|                                        | 64 MiB, 50k   |                                                |
| `list_files`: entries                  | 200           | The rest are counted                           |
| Steps of one review                    | 20, plus one  | The model is asked for its answer (D-116)      |
| Tool requests served from one reply    | 8             | The rest are refused                           |
| Tokens of one review, as reported      | 400,000       | The model is asked for its answer              |
| Output tokens per request              | 4,000         | The provider cuts the reply                    |
| Wall-clock time of one review          | 4 minutes     | No AI answer; the rules stand                  |
| Findings, and AI line comments         | phases 2c, 5  | The rest are counted, not published            |

The ceiling is in tokens, which every provider reports, not in money, which depends on a price
PR Buddy does not know.

## 14. Providers

Runner mode uses the adapters PR Buddy already has (D-060). Each gains the ability to offer
tools and to receive a tool request, behind the same interface; nothing vendor-specific leaks
past the adapter.

| Provider                | Tool calling in its adapter  | Tried live in runner mode |
| ----------------------- | ---------------------------- | ------------------------- |
| AWS Bedrock (Converse)  | Built from its documentation | No                        |
| Anthropic (Messages)    | Built from its documentation | No                        |
| OpenAI                  | Built from its documentation | No                        |
| Azure AI Foundry        | Built, as for OpenAI         | No                        |
| Other compatible server | Varies by server and model   | No                        |

A provider or model that does not answer with usable tool requests is reported as unsupported
for runner mode: the rules still run and the comment says that AI review was not possible. The
last column is filled in only by a real request.

## 15. When things go wrong

| Failure                                         | Result                                                          |
| ----------------------------------------------- | --------------------------------------------------------------- |
| The mode cannot be established                  | No rules, no AI, nothing published; the job fails and says why  |
| The base commit does not say `runner`           | Nothing published; the job passes and says it did nothing       |
| A gate applies                                  | Nothing more is done; the job passes and names the gate         |
| No key, or a fork                               | Rules only                                                      |
| The provider fails, times out or is unsupported | Rules are published; the comment says AI could not complete     |
| The model returns something malformed           | That output is dropped; the rest of the review stands           |
| A limit is reached                              | Verified findings so far are published, marked as stopped early |
| The comment cannot be written                   | The job fails; the job summary still holds the result           |
| A rule fails                                    | As in hosted mode: the others run and the failure is counted    |

An AI problem never fails a review whose rules ran, as in hosted mode (D-048).

## 16. Reporting to a PR Buddy service (phase 4, optional)

Not started until phases 1 to 3 have passed their gates and the Action has shown useful results
on real pull requests (D-106). It stays optional: with no service address configured, nothing
changes for the runner.

- The run obtains GitHub's signed identity token for the service. The service verifies its
  signature, issuer and audience, and takes the repository and the run from its claims (D-103).
- A record is accepted only for a repository of a known installation that has turned reporting
  on.
- What is sent: identifiers, validated findings, counts, timings and token use. Never files,
  diffs, titles, descriptions, tool output or the conversation with the model.
- The endpoint validates everything, limits size and rate, and keeps tenants apart as the rest
  of the service does.

Usage views in the dashboard come only after the endpoint itself has been tested.

## 17. Notifications and measuring outcomes (phase 6, optional)

Later, and only once runner findings have proved useful and re-review tracking reliable: opt-in
notifications to chat, and a clearly defined measure of whether findings were acted on. Neither
is part of the first Action.

## 18. Phases and their gates

A phase starts only when the one before it has passed its gate. Each is a small change of its
own, with its tests, and with the tracker updated in the same change.

| Phase | Delivers                                                                | Gate before the next phase                                                                                                                                                                                          |
| ----- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | This design, the decisions, the threats                                 | The maintainer has reviewed it                                                                                                                                                                                      |
| 1     | The Action without AI: mode, gates, rules, summary comment, job summary | Tests and security checks pass; tried on a real repository with a clean pull request, one with findings, a draft, a closed one, a repeated commit and a re-push; hosted mode seen not to review a runner repository |
| 2     | The three tools, read evidence, the tool loop, one reviewer, the filter | Unit and adversarial tests pass; real requests to providers with test credentials; every provider not tried is recorded as such                                                                                     |
| 3     | Specialists and a lead; re-reviews                                      | Both shapes and re-reviews seen on real pull requests; finding quality, duplicate rate and added cost measured                                                                                                      |
| 4     | Optional reporting to a service; then usage views                       | The endpoint tested for forged, replayed and cross-tenant reports                                                                                                                                                   |
| 5     | AI line comments, off by default                                        | No duplicate notification across re-runs on a real pull request                                                                                                                                                     |
| 6     | Optional notifications; a measure of findings acted on                  | To be defined when it is designed                                                                                                                                                                                   |

Phase 2 is delivered as three changes, so that each can be reviewed on its own. Only the last
one changes what a run does.

| Change | Delivers                                                                   | Status                        |
| ------ | -------------------------------------------------------------------------- | ----------------------------- |
| 2a     | The checkout check, the three tools, the read record, their limits         | Built                         |
| 2b     | Tool calling in each provider's adapter; the bounded tool loop             | Built                         |
| 2c     | The reviewer, the filter, the Action's inputs, the comment; real providers | Built; no real provider tried |

For every phase: the full check from a clean checkout, least-privilege permissions verified,
Actions and images pinned (D-070), a real GitHub workflow exercised, and a record of exactly
what was tried, what passed, what failed and what is unverified. A test, a provider call or a
live check is reported as passed only if it ran.

## 19. Before calling the Action generally available

Decision 5 asks that these be verified, not assumed. As found on 2026-10-11:

| Check                             | Found                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The repository is public          | Yes                                                                                                                                                                  |
| The license                       | `LICENSE` holds the MIT text, with "PR Buddy contributors" as holder. GitHub's own license detection did not report a license for the repository; not yet understood |
| Where to report a vulnerability   | `SECURITY.md` says to use GitHub's "Report a vulnerability". **Private vulnerability reporting is turned off for the repository, so that route does not work today** |
| Disclosure process                | Described in `SECURITY.md`; never exercised                                                                                                                          |
| A contact for the code of conduct | `CODE_OF_CONDUCT.md` points to "the contact method listed on the repository's page"; none is listed                                                                  |
| Installation instructions         | None exist for the Action, because the Action does not exist                                                                                                         |

None of this blocks building. All of it has to be true before the Action is described as ready
for others.

## 20. What this does not do

- Run the repository's linters or tests.
- Publish suggested code changes.
- Keep a memory of past pull requests or team feedback.
- Review across repositories. A checkout is one repository.
- Approve, request changes, block or merge.
- Give runner comments PR Buddy's own identity.
