import { appendFileSync, readFileSync } from "node:fs";
import { createWorkflowRepositoryClient } from "@pr-buddy/github-client";
import { readEnvironment } from "./environment.js";
import { renderFailureSummary, renderJobSummary } from "./job-summary.js";
import { ModeUnknownError, runReview, type RunOutcome } from "./run.js";

/**
 * Entry point of PR Buddy's GitHub Action. It is the only file here that reads the environment
 * or the file system. It prints one line about what happened, writes the job's summary, and
 * exits 0 unless the run itself failed.
 */

const FAILED = 1;

function describeOutcome(outcome: RunOutcome): string {
  switch (outcome.kind) {
    case "not-runner":
      return "Nothing done: the base commit does not select runner mode.";
    case "gated":
      return `Nothing done: ${outcome.gate}.`;
    case "superseded":
      return "Not published: a newer commit arrived.";
    case "reviewed":
      return `Reviewed: ${String(outcome.result.findings.length)} finding(s); comment ${outcome.comment}.`;
  }
}

/** What went wrong, in fixed words. An error's own message could quote the pull request. */
function describeFailure(error: unknown): string {
  if (error instanceof ModeUnknownError) {
    return "The configuration at the pull request's base commit could not be read, so the review mode is unknown. PR Buddy does not review on a guess.";
  }
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  const name = error instanceof Error ? error.name : "Error";
  return typeof status === "number"
    ? `GitHub answered ${String(status)} (${name}). Check that the workflow grants "pull-requests: write" and "contents: read".`
    : `The run stopped with ${name}.`;
}

const read = readEnvironment(process.env, (path) => readFileSync(path, "utf8"));
const summaryPath = read.ok ? read.environment.summaryPath : process.env["GITHUB_STEP_SUMMARY"];

function writeSummary(text: string): void {
  if (summaryPath === undefined || summaryPath === "") {
    return;
  }
  try {
    appendFileSync(summaryPath, text);
  } catch {
    process.stderr.write("The job summary could not be written.\n");
  }
}

if (!read.ok) {
  process.stderr.write(`${read.problem}\n`);
  writeSummary(renderFailureSummary(read.problem));
  process.exit(FAILED);
}

const { token, owner, repo, pullRequestNumber } = read.environment;
try {
  const outcome = await runReview({
    client: createWorkflowRepositoryClient({ token, owner, repo }),
    pullRequestNumber,
  });
  process.stdout.write(`${describeOutcome(outcome)}\n`);
  writeSummary(renderJobSummary(outcome));
} catch (error) {
  const reason = describeFailure(error);
  process.stderr.write(`${reason}\n`);
  writeSummary(renderFailureSummary(reason));
  process.exitCode = FAILED;
}
