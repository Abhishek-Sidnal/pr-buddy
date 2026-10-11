import { providerSettingsSchema, type ProviderSettings } from "@pr-buddy/ai-reviewer";
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
  /** Where the workflow checked the repository out, if it did. */
  readonly workspacePath: string | undefined;
  readonly ai: AiInputs;
}

export type EnvironmentResult =
  | { readonly ok: true; readonly environment: RunnerEnvironment }
  /** `problem` is fixed text that holds no value from the environment. */
  | { readonly ok: false; readonly problem: string };

/** What the workflow said about an AI provider. */
export type AiInputs =
  /** Nothing: the rules run alone. A fork's pull request is always here, having no secrets. */
  | { readonly kind: "none" }
  | { readonly kind: "configured"; readonly settings: ProviderSettings }
  /** `fields` names the inputs that are wrong. It never holds a value. */
  | { readonly kind: "invalid"; readonly fields: readonly string[] };

/** The Action's inputs for a provider, by the setting each one fills. */
const AI_INPUTS = {
  provider: "INPUT_AI-PROVIDER",
  model: "INPUT_AI-MODEL",
  apiKey: "INPUT_AI-API-KEY",
  baseUrl: "INPUT_AI-BASE-URL",
  region: "INPUT_AWS-REGION",
  accessKeyId: "INPUT_AWS-ACCESS-KEY-ID",
  secretAccessKey: "INPUT_AWS-SECRET-ACCESS-KEY",
  sessionToken: "INPUT_AWS-SESSION-TOKEN",
} as const;

/**
 * Reads the provider from the Action's inputs. An input left empty is an input not given: that
 * is what a secret that does not exist looks like, as in a fork's pull request.
 */
export function readAiInputs(variables: Readonly<Record<string, string | undefined>>): AiInputs {
  const given = Object.fromEntries(
    Object.entries(AI_INPUTS)
      .map(([setting, name]) => [setting, variables[name]] as const)
      .filter(([, value]) => value !== undefined && value !== ""),
  );
  if (given["provider"] === undefined) {
    return { kind: "none" };
  }
  const parsed = providerSettingsSchema.safeParse(given);
  if (parsed.success) {
    return { kind: "configured", settings: parsed.data };
  }
  const fields = parsed.error.issues.map((issue) => {
    const setting = String(issue.path[0]);
    return setting in AI_INPUTS
      ? AI_INPUTS[setting as keyof typeof AI_INPUTS].slice("INPUT_".length).toLowerCase()
      : "ai-provider";
  });
  return { kind: "invalid", fields: [...new Set(fields)].sort() };
}

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
      workspacePath: variables["GITHUB_WORKSPACE"],
      ai: readAiInputs(variables),
    },
  };
}
