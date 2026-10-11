import { z } from "zod";
import { MAX_EVENT_BYTES } from "./limits.js";

/** What the runner takes from the workflow it runs in. */
export interface RunnerEnvironment {
  /** The workflow's own token. Never logged, and never shown to a model. */
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  /** Where GitHub collects a job's summary; absent outside GitHub Actions. */
  readonly summaryPath: string | undefined;
}

export type EnvironmentResult =
  | { readonly ok: true; readonly environment: RunnerEnvironment }
  /** `problem` is fixed text that holds no value from the environment. */
  | { readonly ok: false; readonly problem: string };

/** How an input named `github-token` reaches a container action. */
const TOKEN_INPUT = "INPUT_GITHUB-TOKEN";

/** GitHub's names for an account and a repository. */
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/** The one thing read from the event: which pull request. Everything else is fetched. */
const eventSchema = z.object({
  pull_request: z.object({ number: z.number().int().positive() }),
});

/**
 * Reads what the runner needs from its environment. The event file is used only to learn which
 * pull request to look at: what is reviewed is fetched from GitHub, as in hosted mode.
 */
export function readEnvironment(
  variables: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string,
): EnvironmentResult {
  const eventName = variables["GITHUB_EVENT_NAME"];
  if (eventName === "pull_request_target") {
    // That event runs with the base repository's secrets while looking at a stranger's code.
    return {
      ok: false,
      problem:
        "This workflow is triggered by pull_request_target. PR Buddy does not run on that event: it would give secrets to a run that handles code from a fork. Use pull_request.",
    };
  }
  if (eventName !== "pull_request") {
    return {
      ok: false,
      problem: "PR Buddy's runner reviews pull requests. Trigger this workflow with pull_request.",
    };
  }

  const token = variables[TOKEN_INPUT];
  if (token === undefined || token === "") {
    return { ok: false, problem: "No GitHub token was given to the action." };
  }

  const repository = REPOSITORY.exec(variables["GITHUB_REPOSITORY"] ?? "");
  const [, owner, repo] = repository ?? [];
  if (owner === undefined || repo === undefined) {
    return { ok: false, problem: "GITHUB_REPOSITORY does not name a repository." };
  }

  const eventPath = variables["GITHUB_EVENT_PATH"];
  if (eventPath === undefined || eventPath === "") {
    return { ok: false, problem: "GITHUB_EVENT_PATH is not set." };
  }
  let event: unknown;
  try {
    const text = readFile(eventPath);
    if (text.length > MAX_EVENT_BYTES) {
      return { ok: false, problem: "The event file is too large to read." };
    }
    event = JSON.parse(text);
  } catch {
    return { ok: false, problem: "The event file could not be read." };
  }
  const parsed = eventSchema.safeParse(event);
  if (!parsed.success) {
    return { ok: false, problem: "The event does not name a pull request." };
  }

  const summaryPath = variables["GITHUB_STEP_SUMMARY"];
  return {
    ok: true,
    environment: {
      token,
      owner,
      repo,
      pullRequestNumber: parsed.data.pull_request.number,
      summaryPath: summaryPath === undefined || summaryPath === "" ? undefined : summaryPath,
    },
  };
}
