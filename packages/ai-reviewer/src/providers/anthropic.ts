import { z } from "zod";
import type { AiProvider, AiResponse } from "../provider.js";
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

/** The parts of a Messages reply that are used. Blocks that are not text are skipped. */
const messagesResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

/** Anthropic, through its Messages API. */
export function createAnthropicProvider(options: AnthropicOptions): AiProvider {
  const { model, apiKey } = options;
  const send = options.fetch ?? fetch;
  const url = `${options.baseUrl ?? ANTHROPIC_BASE_URL}/v1/messages`;

  return {
    name: "anthropic",
    model,

    async complete(request): Promise<AiResponse> {
      const reply = messagesResponseSchema.safeParse(
        await postJson(send, {
          url,
          headers: {
            "content-type": "application/json",
            "anthropic-version": API_VERSION,
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: [{ role: "user", content: request.user }],
          }),
          signal: request.signal,
        }),
      );
      if (!reply.success) {
        throw new ProviderResponseError();
      }
      const text = reply.data.content
        .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
        .join("");
      const { usage } = reply.data;
      return {
        text,
        ...(usage === undefined
          ? {}
          : { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }),
      };
    },
  };
}
