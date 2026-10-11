import { errorNameOf } from "./error-name.js";
import {
  DEFAULT_TOOL_LOOP_TIMEOUT_MS,
  MAX_TOOL_CALLS_PER_STEP,
  MAX_TOOL_LOOP_TOKENS,
  MAX_TOOL_RESULT_LENGTH,
  MAX_TOOL_STEP_OUTPUT_TOKENS,
  MAX_TOOL_STEPS,
} from "./limits.js";
import {
  aiTurnSchema,
  type AiMessage,
  type AiToolCall,
  type AiToolCallResult,
  type AiToolProvider,
  type AiTurn,
  type AiUsage,
} from "./provider.js";
import type { AiTool } from "./tool.js";

/** What bounds one conversation. Each is a ceiling on cost or time (D-097). */
export interface ToolLoopLimits {
  /** Requests to the model, the closing one not counted. */
  readonly maxSteps: number;
  /** Input and output tokens, summed over all requests, as the provider reports them. */
  readonly maxTokens: number;
  readonly maxStepOutputTokens: number;
  /** Wall-clock time for everything, in milliseconds. */
  readonly timeoutMs: number;
}

export const TOOL_LOOP_LIMITS: ToolLoopLimits = {
  maxSteps: MAX_TOOL_STEPS,
  maxTokens: MAX_TOOL_LOOP_TOKENS,
  maxStepOutputTokens: MAX_TOOL_STEP_OUTPUT_TOKENS,
  timeoutMs: DEFAULT_TOOL_LOOP_TIMEOUT_MS,
};

/** Why the model gave its answer when it did. */
export type ToolLoopStop =
  /** It answered without asking for another tool. */
  | "answered"
  /** The limit on steps was reached, and it was asked to answer. */
  | "steps"
  /** The limit on tokens was reached, and it was asked to answer. */
  | "tokens"
  /** The caller's own limit was reached, such as the budget for tool output. */
  | "caller";

export type ToolLoopFailure = "timeout" | "provider-error" | "invalid-response";

interface ToolLoopCounts {
  /** Requests made to the model, the closing one included. */
  readonly requestCount: number;
  /** Tool requests served, refused ones included. */
  readonly toolCallCount: number;
  /** Summed over all requests. Absent if the provider never reported it. */
  readonly usage?: AiUsage;
  readonly durationMs: number;
}

export type ToolLoopResult =
  | (ToolLoopCounts & {
      readonly status: "completed";
      /** The model's last reply, unprocessed. It is untrusted input for whoever reads it. */
      readonly text: string;
      readonly stop: ToolLoopStop;
    })
  | (ToolLoopCounts & {
      readonly status: "failed";
      readonly failureReason: ToolLoopFailure;
      /** The name of the provider's error. Its message is never kept. */
      readonly errorName?: string;
    });

export interface ToolLoopOptions {
  readonly provider: AiToolProvider;
  /** Fixed instructions. Contains nothing from the pull request. */
  readonly system: string;
  /** The first message: the pull request, as data. */
  readonly user: string;
  readonly tools: readonly AiTool[];
  readonly limits?: Partial<ToolLoopLimits>;
  /** Asked after each step's tools ran. True ends the conversation with a closing request. */
  readonly shouldStop?: () => boolean;
  /** Replaceable so tests control time. Returns milliseconds. */
  readonly now?: () => number;
}

/** Sent when a limit ends the conversation. Fixed text. */
export const CLOSING_MESSAGE =
  "A limit of this review is reached and no more tools can be used. Reply now with your final answer in the required form, based only on what you have read so far.";

export const UNKNOWN_TOOL = "There is no tool with that name.";
export const TOO_MANY_CALLS = `Too many tool requests in one reply; at most ${MAX_TOOL_CALLS_PER_STEP} are served. Ask again for this one if it is still needed.`;
export const TOOL_FAILED = "The tool could not complete that request.";

class LoopTimeoutError extends Error {}
class InvalidTurnError extends Error {}

/** Runs the tools one reply asked for, in order. Nothing a tool does can reject the loop. */
async function runTools(
  calls: readonly AiToolCall[],
  tools: ReadonlyMap<string, AiTool>,
): Promise<AiToolCallResult[]> {
  const results: AiToolCallResult[] = [];
  for (const [index, call] of calls.entries()) {
    const refuse = (text: string): void => {
      results.push({ id: call.id, name: call.name, text, isRefused: true });
    };
    if (index >= MAX_TOOL_CALLS_PER_STEP) {
      refuse(TOO_MANY_CALLS);
      continue;
    }
    const tool = tools.get(call.name);
    if (tool === undefined) {
      refuse(UNKNOWN_TOOL);
      continue;
    }
    try {
      const result = await tool.run(call.input);
      results.push({
        id: call.id,
        name: call.name,
        text: result.text.slice(0, MAX_TOOL_RESULT_LENGTH),
        isRefused: result.isRefused,
      });
    } catch {
      // The error may quote a path or a file; only the fact that it failed is passed on.
      refuse(TOOL_FAILED);
    }
  }
  return results;
}

/**
 * Holds one conversation with a model that may ask for tools, within fixed limits, and returns
 * its last reply. This is PR Buddy's own loop over the provider's API: the model can do nothing
 * but ask for the tools it was given (D-097).
 *
 * When a limit on steps or tokens is reached, the model is asked once more, without tools, for
 * the answer it can give from what it has read. When time runs out there is no answer.
 *
 * Never rejects because of the provider, its reply or a tool; see `ToolLoopResult.status`.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const { provider, system, shouldStop } = options;
  const limits = { ...TOOL_LOOP_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const startedAt = now();
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  const definitions = options.tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));

  const messages: AiMessage[] = [{ role: "user", text: options.user }];
  let requestCount = 0;
  let toolCallCount = 0;
  let usage: AiUsage | undefined;
  const counts = (): ToolLoopCounts => ({
    requestCount,
    toolCallCount,
    ...(usage === undefined ? {} : { usage }),
    durationMs: Math.max(0, Math.round(now() - startedAt)),
  });

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LoopTimeoutError());
    }, limits.timeoutMs);
  });
  // Time may run out while a tool runs and nothing awaits this promise.
  timeout.catch(() => undefined);

  const ask = async (toolChoice: "auto" | "none"): Promise<AiTurn> => {
    if (controller.signal.aborted) {
      throw new LoopTimeoutError();
    }
    requestCount += 1;
    const answer: unknown = await Promise.race([
      Promise.resolve().then(() =>
        provider.converse({
          system,
          // A copy: the provider must not see the list change under it.
          messages: [...messages],
          tools: definitions,
          toolChoice,
          maxOutputTokens: limits.maxStepOutputTokens,
          signal: controller.signal,
        }),
      ),
      timeout,
    ]);
    const turn = aiTurnSchema.safeParse(answer);
    if (!turn.success) {
      throw new InvalidTurnError();
    }
    if (turn.data.usage !== undefined) {
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + turn.data.usage.inputTokens,
        outputTokens: (usage?.outputTokens ?? 0) + turn.data.usage.outputTokens,
      };
    }
    return {
      text: turn.data.text,
      toolCalls: turn.data.toolCalls.map(({ id, name, input }) => ({ id, name, input })),
    };
  };

  try {
    let stop: ToolLoopStop = "steps";
    for (let step = 0; step < limits.maxSteps; step += 1) {
      const turn = await ask("auto");
      if (turn.toolCalls.length === 0) {
        return { ...counts(), status: "completed", text: turn.text, stop: "answered" };
      }
      messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });
      const results = await runTools(turn.toolCalls, tools);
      toolCallCount += results.length;
      messages.push({ role: "tool", results });

      if (shouldStop?.() === true) {
        stop = "caller";
        break;
      }
      if (usage !== undefined && usage.inputTokens + usage.outputTokens >= limits.maxTokens) {
        stop = "tokens";
        break;
      }
    }

    // The request for the answer travels with the last tool answers, as one turn of the user:
    // some providers refuse two turns of the same side in a row.
    const last = messages.at(-1);
    if (last?.role === "tool") {
      messages[messages.length - 1] = { ...last, note: CLOSING_MESSAGE };
    }
    const closing = await ask("none");
    return { ...counts(), status: "completed", text: closing.text, stop };
  } catch (error) {
    if (error instanceof LoopTimeoutError) {
      return { ...counts(), status: "failed", failureReason: "timeout" };
    }
    if (error instanceof InvalidTurnError) {
      return { ...counts(), status: "failed", failureReason: "invalid-response" };
    }
    return {
      ...counts(),
      status: "failed",
      failureReason: "provider-error",
      errorName: errorNameOf(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
