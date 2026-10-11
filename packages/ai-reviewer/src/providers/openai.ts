import { z } from "zod";
import type { AiMessage, AiResponse, AiToolProvider, AiTurn, AiUsage } from "../provider.js";
import { postJson, ProviderResponseError } from "./http.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * The three services that speak the Chat Completions API differ in small ways:
 *
 * - `openai`: OpenAI itself. Bearer key, `max_completion_tokens`, JSON mode.
 * - `azure`: Azure AI Foundry or Azure OpenAI, at the resource's `/openai/v1`. The key travels in
 *   an `api-key` header and the model is the name of a deployment.
 * - `openai-compatible`: any other server with the same API, including models run locally. It
 *   gets the older `max_tokens` and no JSON mode, which is what such servers reliably accept.
 */
export type ChatCompletionsDialect = "openai" | "azure" | "openai-compatible";

export interface ChatCompletionsOptions {
  readonly dialect: ChatCompletionsDialect;
  /** A model name; for `azure`, the name of the deployment. */
  readonly model: string;
  /** Optional only for `openai-compatible`: a local server may need none. */
  readonly apiKey?: string;
  /** Where the API is reached, up to but not including `/chat/completions`. */
  readonly baseUrl: string;
  /** Replaces the global `fetch`; used by tests. */
  readonly fetch?: typeof fetch;
}

const chatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish(),
});

type ChatCompletion = z.infer<typeof chatCompletionSchema>;

function authHeaders(dialect: ChatCompletionsDialect, apiKey: string | undefined): object {
  if (apiKey === undefined) {
    return {};
  }
  return dialect === "azure" ? { "api-key": apiKey } : { authorization: `Bearer ${apiKey}` };
}

function usageOf(reply: ChatCompletion): { usage: AiUsage } | object {
  const { usage } = reply;
  return usage === undefined || usage === null
    ? {}
    : { usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } };
}

/**
 * A tool's input arrives as JSON in a string. Text that is not JSON becomes `undefined`, which
 * every tool refuses as invalid input: the model is told, and can ask again.
 */
function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A conversation in the Chat Completions form: each tool answer is a message of its own. */
function toMessages(system: string, messages: readonly AiMessage[]): unknown[] {
  return [
    { role: "system", content: system },
    ...messages.flatMap((message): unknown[] => {
      switch (message.role) {
        case "user":
          return [{ role: "user", content: message.text }];
        case "assistant":
          return [
            {
              role: "assistant",
              content: message.text === "" ? null : message.text,
              ...(message.toolCalls.length === 0
                ? {}
                : {
                    tool_calls: message.toolCalls.map((call) => ({
                      id: call.id,
                      type: "function",
                      function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
                    })),
                  }),
            },
          ];
        case "tool":
          return [
            ...message.results.map((result) => ({
              role: "tool",
              tool_call_id: result.id,
              content: result.text,
            })),
            ...(message.note === undefined ? [] : [{ role: "user", content: message.note }]),
          ];
      }
    }),
  ];
}

/** OpenAI, Azure AI Foundry, or any service with the Chat Completions API. */
export function createChatCompletionsProvider(options: ChatCompletionsOptions): AiToolProvider {
  const { dialect, model } = options;
  const send = options.fetch ?? fetch;
  const url = `${options.baseUrl}/chat/completions`;
  const isStrictDialect = dialect !== "openai-compatible";
  const outputLimit = (maxOutputTokens: number): object =>
    isStrictDialect ? { max_completion_tokens: maxOutputTokens } : { max_tokens: maxOutputTokens };

  const post = async (body: object, signal: AbortSignal): Promise<ChatCompletion> => {
    const reply = chatCompletionSchema.safeParse(
      await postJson(send, {
        url,
        headers: { "content-type": "application/json", ...authHeaders(dialect, options.apiKey) },
        body: JSON.stringify(body),
        signal,
      }),
    );
    if (!reply.success) {
      throw new ProviderResponseError();
    }
    return reply.data;
  };

  return {
    name: dialect,
    model,

    async complete(request): Promise<AiResponse> {
      const reply = await post(
        {
          model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          ...outputLimit(request.maxOutputTokens),
          ...(isStrictDialect ? { response_format: { type: "json_object" } } : {}),
        },
        request.signal,
      );
      return { text: reply.choices[0]?.message.content ?? "", ...usageOf(reply) };
    },

    // No JSON mode here: a reply that asks for a tool is not a JSON document.
    async converse(request): Promise<AiTurn> {
      const reply = await post(
        {
          model,
          messages: toMessages(request.system, request.messages),
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
          tool_choice: request.toolChoice,
          ...outputLimit(request.maxOutputTokens),
        },
        request.signal,
      );
      const message = reply.choices[0]?.message;
      return {
        text: message?.content ?? "",
        toolCalls: (message?.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          input: parseArguments(call.function.arguments),
        })),
        ...usageOf(reply),
      };
    },
  };
}
