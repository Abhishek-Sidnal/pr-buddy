# PR Buddy as a GitHub Action (runner mode)

How to review a repository's pull requests with PR Buddy inside the repository's own CI, with no
PR Buddy service involved. Design: [DESIGN-RUNNER.md](DESIGN-RUNNER.md).

> **Status: phase 1.** The Action runs PR Buddy's deterministic rules and posts one summary
> comment. It asks no AI model; that is a later phase. What has been tried on a real repository,
> and what has not, is in [TRACKER.md](TRACKER.md) under Milestone 7. It is not yet described as
> generally available: see the open checks in DESIGN-RUNNER.md, section 19.

## 1. What you get

- The same rules as the hosted service ([RULES.md](RULES.md)), run on GitHub's runner.
- One summary comment on the pull request, updated on each push and never repeated.
- A job summary that says what was found, or which gate stopped the run.
- Nothing from the pull request is installed, built or run, and no checkout is needed.

It never approves, requests changes, blocks or merges.

## 2. Turn it on

Two changes, both on the repository's **default branch**.

**1. Select runner mode** in `.github/pr-buddy.json`:

```json
{
  "review": { "mode": "runner" }
}
```

**2. Add the workflow.** Copy [`examples/runner-workflow.yml`](../examples/runner-workflow.yml) to
`.github/workflows/pr-buddy.yml`, and replace `<full commit SHA>` with the commit of PR Buddy
you want to run. Pin a commit, not a branch: a branch can move.

The mode is read from the pull request's **base** commit, so:

- A pull request that adds or changes `.github/pr-buddy.json` is reviewed by the mode the base
  branch already has. The change takes effect for pull requests opened or updated after it is
  merged.
- Until the base branch says `runner`, the Action does nothing and says so in the job summary.

If the PR Buddy app is also installed on the repository, the hosted service sees the same
setting and stops reviewing that repository. A repository is never reviewed by both.

**If the PR Buddy app is installed too, its service must know about runner mode first.** A
service older than this feature treats `review.mode` as an unknown setting, calls the file
invalid and reviews the repository as before, beside the Action. Upgrade the service, then
select runner mode.

## 3. Permissions

| Permission             | Why                                                |
| ---------------------- | -------------------------------------------------- |
| `contents: read`       | To read `.github/pr-buddy.json` at the base commit |
| `pull-requests: write` | To read the pull request and write the comment     |

No other permission is needed. Do not use `pull_request_target`: the Action refuses to run on
it, because that event gives a repository's secrets to a run that handles code from a fork.

## 4. What stops a run

Each of these ends the run early, with a line in the job summary and a passing job.

| Gate                                  | What happens                                      |
| ------------------------------------- | ------------------------------------------------- |
| The base branch is not in runner mode | Nothing. The summary says how to select it        |
| The pull request is closed or merged  | Nothing                                           |
| The pull request is a draft           | Nothing, until it is marked ready                 |
| This commit was already reviewed      | Nothing: the comment names the commit it reviewed |
| A newer commit arrived during the run | The result is dropped; the newer run publishes    |

A push that changes fewer than 50 lines of code since the last review is reported as a small
re-push. The rules run again anyway: they cost nothing, and the comment must not keep a finding
the push removed. From the phase that adds AI review, a small re-push will skip the model.

The job **fails** when the configuration at the base commit cannot be read at all, or when
GitHub refuses a request. It then publishes nothing.

## 5. Pull requests from forks

GitHub gives a fork's pull request a token that cannot write. PR Buddy still runs the rules, and
puts the findings in the job summary when it cannot comment. Nothing is loosened to change that.

## 6. The comment

It appears as **GitHub Actions**, because it is written with the workflow's own token. PR Buddy
only ever updates a comment that carries its marker and was written by that identity. It never
edits a person's comment, or another automation's.

A pull request with no findings gets no comment. If an earlier comment exists, it is updated to
say that nothing is left.

## 7. Differences from the hosted service

|                                 | Hosted                   | Runner (phase 1)       |
| ------------------------------- | ------------------------ | ---------------------- |
| Rules                           | The same                 | The same               |
| Summary comment                 | Yes, as the PR Buddy app | Yes, as GitHub Actions |
| Line comments for rule findings | Yes                      | No                     |
| AI review                       | Optional                 | Not yet                |
| History and dashboard           | Yes                      | No                     |
| Runs where                      | The service              | The repository's CI    |

## 8. Limits

- Linux runners only: the Action is a container.
- The image is built at the start of each run. In the first real runs a whole job, build included,
  took 34 to 39 seconds.
- The Action pins its own base image by digest; you pin the Action by commit.
