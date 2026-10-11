import {
  createProvider,
  reviewWithTools,
  type AiToolProvider,
  type ProviderSettings,
  type ToolLoopLimits,
  type ToolReview,
} from "@pr-buddy/ai-reviewer";
import type { ReportThresholds, ReviewContext, ReviewFinding } from "@pr-buddy/review-engine";
import type { AiInputs } from "./environment.js";
import type { RepushSize } from "./gates.js";
import { createCheckoutTools } from "./tools/checkout-tools.js";
import { openCheckout } from "./tools/checkout.js";
import { createReadRecord } from "./tools/read-record.js";
import { createOutputBudget } from "./tools/tool-context.js";

/** Why no model was asked. Each is decided before any request that costs money. */
export type AiSkipReason =
  /** The repository's configuration at the base commit does not turn AI review on. */
  | "not-enabled"
  /** The workflow gave no provider. A fork's pull request is always here: it has no secrets. */
  | "no-provider"
  /** The workflow's provider inputs do not make a usable provider. */
  | "invalid-provider"
  /** The pull request has more files or a larger diff than could be loaded. */
  | "too-large"
  /** The push changed little since the last review. */
  | "small-repush"
  /** The workflow did not check the repository out. */
  | "no-checkout"
  /** The checkout is not at the pull request's head commit. */
  | "wrong-checkout";

export type AiOutcome =
  | {
      readonly kind: "skipped";
      readonly reason: AiSkipReason;
      /** For "invalid-provider": the names of the inputs that are wrong, never a value. */
      readonly fields?: readonly string[];
    }
  | {
      readonly kind: "asked";
      /** The service and the model, for the comment and the job summary. */
      readonly model: string;
      readonly review: ToolReview;
      /** Files and lines the tools returned, the diff's own lines included. */
      readonly readFileCount: number;
      readonly readLineCount: number;
    };

/** What the AI step takes from the workflow. */
export interface AiDependencies {
  readonly inputs: AiInputs;
  /** Where the workflow checked the repository out, if it did. */
  readonly workspacePath: string | undefined;
  /** Replaces the real providers; used by tests. */
  readonly createProvider?: (settings: ProviderSettings) => AiToolProvider;
  readonly limits?: Partial<ToolLoopLimits>;
}

export interface AiStepInput {
  readonly ai: AiDependencies | undefined;
  /** `ai.enabled` of the configuration at the base commit. */
  readonly isAiEnabled: boolean;
  readonly headSha: string;
  /** The validated pull request the rules reviewed. */
  readonly context: ReviewContext;
  readonly ruleFindings: readonly ReviewFinding[];
  readonly thresholds: ReportThresholds;
  readonly repush: RepushSize;
  /** Whether part of the pull request could not be loaded: files unlisted, or diffs omitted. */
  readonly isIncomplete: boolean;
}

function skipped(reason: AiSkipReason): AiOutcome {
  return { kind: "skipped", reason };
}

/**
 * Asks a model about the pull request, if every gate allows it. The gates come first and cost
 * nothing; none of them stops the rules, which have already run (D-109). The model reads the
 * checkout through three read-only tools and nothing else (docs/DESIGN-RUNNER.md, section 8).
 *
 * Never rejects because of the provider: an AI problem must not fail a review whose rules ran.
 */
export async function runAiStep(input: AiStepInput): Promise<AiOutcome> {
  const { ai } = input;
  if (!input.isAiEnabled) {
    return skipped("not-enabled");
  }
  if (ai === undefined || ai.inputs.kind === "none") {
    return skipped("no-provider");
  }
  if (ai.inputs.kind === "invalid") {
    return { kind: "skipped", reason: "invalid-provider", fields: ai.inputs.fields };
  }
  if (input.isIncomplete) {
    return skipped("too-large");
  }
  if (input.repush.kind === "small") {
    return skipped("small-repush");
  }
  const opened = await openCheckout(ai.workspacePath, input.headSha);
  if (!opened.ok) {
    return skipped(opened.problem === "missing" ? "no-checkout" : "wrong-checkout");
  }

  const provider = (ai.createProvider ?? createProvider)(ai.inputs.settings);
  const record = createReadRecord();
  const budget = createOutputBudget();
  const review = await reviewWithTools({
    provider,
    context: input.context,
    tools: createCheckoutTools({ checkout: opened.checkout, record, budget }),
    evidence: record,
    thresholds: input.thresholds,
    ruleFindings: input.ruleFindings,
    shouldStop: () => budget.isExhausted,
    ...(ai.limits === undefined ? {} : { limits: ai.limits }),
  });
  return {
    kind: "asked",
    model: `${provider.name}/${provider.model}`,
    review,
    readFileCount: record.fileCount,
    readLineCount: record.lineCount,
  };
}
