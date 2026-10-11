import { z } from "zod";
import type { AiMessage, AiResponse, AiToolProvider, AiTurn, AiUsage } from "../provider.js";
import { postJson, ProviderResponseError } from "./http.js";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** The version of the Messages API this adapter was written for. */
const API_VERSION = "2023-06-01";

export interface AnthropicOptions {
  readonly model: string;
  readonly apiKey: string;
  /** Where the API is reached, without a trailing slash. Defaults to Anthropic's own. */
  readonly baseUrl?: string;
  /** Replaces the global `fetch`; used by tests. */
  readonly fetch?: typeof fetch;
}

/**
 * The parts of a Messages reply that are used: text, and requests for tools. Other blocks, such
 * as reasoning, are skipped.
 */
const messagesResponseSchema = z.object({
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      input: z.unknown().optional(),
    }),
  ),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

type MessagesResponse = z.infer<typeof messagesResponseSchema>;

function textOf(reply: MessagesResponse): string {
  return reply.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

function usageOf(reply: MessagesResponse): { usage: AiUsage } | object {
  const { usage } = reply;
  return usage === undefined
    ? {}
    : { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } };
}

/** A conversation in the Messages API's form. An empty text block is not accepted, so none is sent. */
function toMessages(messages: readonly AiMessage[]): unknown[] {
  return messages.map((message) => {
    switch (message.role) {
      case "user":
        return { role: "user", content: message.text };
      case "assistant":
        return {
          role: "assistant",
          content: [
            ...(message.text === "" ? [] : [{ type: "text", text: message.text }]),
            ...message.toolCalls.map((call) => ({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.input,
            })),
          ],
        };
      case "tool":
        return {
          role: "user",
          content: [
            ...message.results.map((result) => ({
              type: "tool_result",
              tool_use_id: result.id,
              content: result.text,
              is_error: result.isRefused,
            })),
            ...(message.note === undefined ? [] : [{ type: "text", text: message.note }]),
          ],
        };
    }
  });
}

/** Anthropic, through its Messages API. */
export function createAnthropicProvider(options: AnthropicOptions): AiToolProvider {
  const { model, apiKey } = options;
  const send = options.fetch ?? fetch;
  const url = `${options.baseUrl ?? ANTHROPIC_BASE_URL}/v1/messages`;

  const post = async (body: object, signal: AbortSignal): Promise<MessagesResponse> => {
    const reply = messagesResponseSchema.safeParse(
      await postJson(send, {
        url,
        headers: {
          "content-type": "application/json",
          "anthropic-version": API_VERSION,
          "x-api-key": apiKey,
        },
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
    name: "anthropic",
    model,

    async complete(request): Promise<AiResponse> {
      const reply = await post(
        {
          model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
        },
        request.signal,
      );
      return { text: textOf(reply), ...usageOf(reply) };
    },

    async converse(request): Promise<AiTurn> {
      const reply = await post(
        {
          model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: toMessages(request.messages),
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
          tool_choice: { type: request.toolChoice },
        },
        request.signal,
      );
      return {
        text: textOf(reply),
        toolCalls: reply.content.flatMap((block) =>
          block.type === "tool_use" && block.id !== undefined && block.name !== undefined
            ? [{ id: block.id, name: block.name, input: block.input }]
            : [],
        ),
        ...usageOf(reply),
      };
    },
  };
}
