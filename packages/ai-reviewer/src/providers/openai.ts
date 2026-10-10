import { z } from "zod";
import type { AiProvider, AiResponse } from "../provider.js";
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
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish(),
});

function authHeaders(dialect: ChatCompletionsDialect, apiKey: string | undefined): object {
  if (apiKey === undefined) {
    return {};
  }
  return dialect === "azure" ? { "api-key": apiKey } : { authorization: `Bearer ${apiKey}` };
}

/** OpenAI, Azure AI Foundry, or any service with the Chat Completions API. */
export function createChatCompletionsProvider(options: ChatCompletionsOptions): AiProvider {
  const { dialect, model } = options;
  const send = options.fetch ?? fetch;
  const url = `${options.baseUrl}/chat/completions`;
  const isStrictDialect = dialect !== "openai-compatible";

  return {
    name: dialect,
    model,

    async complete(request): Promise<AiResponse> {
      const reply = chatCompletionSchema.safeParse(
        await postJson(send, {
          url,
          headers: { "content-type": "application/json", ...authHeaders(dialect, options.apiKey) },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            ...(isStrictDialect
              ? {
                  max_completion_tokens: request.maxOutputTokens,
                  response_format: { type: "json_object" },
                }
              : { max_tokens: request.maxOutputTokens }),
          }),
          signal: request.signal,
        }),
      );
      if (!reply.success) {
        throw new ProviderResponseError();
      }
      const { usage } = reply.data;
      return {
        text: reply.data.choices[0]?.message.content ?? "",
        ...(usage === undefined || usage === null
          ? {}
          : {
              usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens },
            }),
      };
    },
  };
}
