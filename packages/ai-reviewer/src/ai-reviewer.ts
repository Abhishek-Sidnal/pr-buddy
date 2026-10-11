import {
  compareSeverity,
  ConfigurationError,
  type ReportThresholds,
  type ReviewContext,
  type ReviewFinding,
} from "@pr-buddy/review-engine";
import { z } from "zod";
import { errorNameOf } from "./error-name.js";
import { DEFAULT_AI_TIMEOUT_MS, MAX_AI_TIMEOUT_MS, MAX_OUTPUT_TOKENS } from "./limits.js";
import { parseResponse } from "./output/parse-response.js";
import { toFindings } from "./output/to-findings.js";
import { buildPrompt, type Prompt } from "./prompt/build-prompt.js";
import { selectFiles } from "./prompt/select-files.js";
import {
  aiResponseSchema,
  providerLabelSchema,
  type AiProvider,
  type AiUsage,
} from "./provider.js";

export type AiReviewStatus = "completed" | "skipped" | "failed";
export type AiFailureReason = "timeout" | "provider-error" | "invalid-response";

/** What came of asking a model about one pull request. */
export interface AiReview {
  /** "skipped" means there was nothing that could be sent, so no request was made. */
  readonly status: AiReviewStatus;
  /** Present when `status` is "failed". */
  readonly failureReason?: AiFailureReason;
  /** The name of the provider's error. Its message is never kept: it may echo the prompt. */
  readonly errorName?: string;
  /** Verified suggestions that meet the reporting thresholds. Empty unless completed. */
  readonly findings: readonly ReviewFinding[];
  /** Verified suggestions hidden by the reporting thresholds. */
  readonly suppressedFindingCount: number;
  /** Entries of the reply that were malformed or pointed at a place that was not sent. */
  readonly rejectedFindingCount: number;
  readonly sentFileCount: number;
  /** Files with changes that were not sent: excluded by name, or over the size budget. */
  readonly omittedFileCount: number;
  readonly usage?: AiUsage;
  readonly durationMs: number;
}

export interface AiReviewer {
  /** Name of the service that receives the pull request content. */
  readonly provider: string;
  readonly model: string;
  /**
   * Asks the model about a pull request that the engine has already validated. Never rejects
   * because of the provider or its reply; see `AiReview.status`.
   */
  review(context: ReviewContext, thresholds?: ReportThresholds): Promise<AiReview>;
}

export interface AiReviewerOptions {
  readonly provider: AiProvider;
  /** Time limit for the provider's reply, in milliseconds. */
  readonly timeoutMs?: number;
  /** Replaceable so tests control time. Returns milliseconds. */
  readonly now?: () => number;
}

const optionsSchema = z.object({
  name: providerLabelSchema,
  model: providerLabelSchema,
  timeoutMs: z.number().int().min(1).max(MAX_AI_TIMEOUT_MS),
});

class AiTimeoutError extends Error {}

/** Runs one request. The provider is told to stop when time is up, and is not waited for. */
async function completeWithin(
  provider: AiProvider,
  prompt: Prompt,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        provider.complete({
          ...prompt,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          signal: controller.signal,
        }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function meetsThresholds(finding: ReviewFinding, thresholds: ReportThresholds): boolean {
  return (
    compareSeverity(finding.severity, thresholds.minSeverity) >= 0 &&
    finding.confidence >= thresholds.minConfidence
  );
}

/**
 * Creates an AI reviewer around one provider.
 * @throws {ConfigurationError} if the provider's name or model, or the time limit, is unusable.
 */
export function createAiReviewer(options: AiReviewerOptions): AiReviewer {
  const { provider } = options;
  const now = options.now ?? Date.now;
  const parsed = optionsSchema.safeParse({
    name: provider.name,
    model: provider.model,
    timeoutMs: options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
  });
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map(
        (issue) => `AI provider ${issue.path.map(String).join(".")}: ${issue.message}`,
      ),
    );
  }
  const { name, model, timeoutMs } = parsed.data;

  return {
    provider: name,
    model,

    async review(context, thresholds) {
      const startedAt = now();
      const { selected, omittedFileCount } = selectFiles(context.files);
      const base = {
        findings: [],
        suppressedFindingCount: 0,
        rejectedFindingCount: 0,
        sentFileCount: selected.length,
        omittedFileCount,
      };
      const elapsed = (): number => Math.max(0, Math.round(now() - startedAt));

      if (selected.length === 0) {
        return { ...base, status: "skipped", durationMs: elapsed() };
      }

      let answer: unknown;
      try {
        answer = await completeWithin(
          provider,
          buildPrompt(context.pullRequest, selected),
          timeoutMs,
        );
      } catch (error) {
        return error instanceof AiTimeoutError
          ? { ...base, status: "failed", failureReason: "timeout", durationMs: elapsed() }
          : {
              ...base,
              status: "failed",
              failureReason: "provider-error",
              errorName: errorNameOf(error),
              durationMs: elapsed(),
            };
      }

      const response = aiResponseSchema.safeParse(answer);
      const usage = response.data?.usage;
      const withUsage = usage === undefined ? base : { ...base, usage };
      const reply = response.success ? parseResponse(response.data.text) : undefined;
      if (reply === undefined) {
        return {
          ...withUsage,
          status: "failed",
          failureReason: "invalid-response",
          durationMs: elapsed(),
        };
      }

      const verified = toFindings(
        reply.suggestions,
        selected.map(({ file }) => file),
      );
      const findings =
        thresholds === undefined
          ? verified.findings
          : verified.findings.filter((finding) => meetsThresholds(finding, thresholds));
      return {
        ...withUsage,
        status: "completed",
        findings,
        suppressedFindingCount: verified.findings.length - findings.length,
        rejectedFindingCount: reply.rejectedCount + verified.rejectedCount,
        durationMs: elapsed(),
      };
    },
  };
}
