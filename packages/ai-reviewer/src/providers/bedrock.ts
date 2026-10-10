import { z } from "zod";
import type { AiProvider, AiResponse } from "../provider.js";
import { postJson, ProviderResponseError } from "./http.js";
import { signAwsRequest, type AwsCredentials } from "./sigv4.js";

/** How a request to Bedrock proves who sent it. */
export type BedrockAuth =
  /** A Bedrock API key, sent as a bearer token. */
  | { readonly apiKey: string }
  /** An AWS access key; each request is signed with Signature Version 4. */
  | { readonly credentials: AwsCredentials };

export interface BedrockOptions {
  /** A model ID or inference profile ID that the account may use in `region`. */
  readonly model: string;
  readonly region: string;
  readonly auth: BedrockAuth;
  /** Replaces the global `fetch`; used by tests. */
  readonly fetch?: typeof fetch;
  /** Replaceable so tests control the signing time. */
  readonly now?: () => Date;
}

/** The parts of a Converse reply that are used. Blocks without text, such as reasoning, are skipped. */
const converseResponseSchema = z.object({
  output: z.object({
    message: z.object({ content: z.array(z.object({ text: z.string().optional() })) }),
  }),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
});

/**
 * AWS Bedrock, through its Converse API: one request shape for every model family, so the same
 * adapter serves Anthropic, Amazon, Meta and other models hosted there.
 */
export function createBedrockProvider(options: BedrockOptions): AiProvider {
  const { model, region, auth } = options;
  const send = options.fetch ?? fetch;
  const now = options.now ?? ((): Date => new Date());
  // A model ID contains ":" and an ARN contains "/"; both must be encoded to stay one segment.
  const url = new URL(
    `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`,
  );

  return {
    name: "bedrock",
    model,

    async complete(request): Promise<AiResponse> {
      const body = JSON.stringify({
        system: [{ text: request.system }],
        messages: [{ role: "user", content: [{ text: request.user }] }],
        inferenceConfig: { maxTokens: request.maxOutputTokens },
      });
      const baseHeaders = { "content-type": "application/json", accept: "application/json" };

      let headers: Record<string, string>;
      if ("apiKey" in auth) {
        headers = { ...baseHeaders, authorization: `Bearer ${auth.apiKey}` };
      } else {
        const signed = signAwsRequest({
          method: "POST",
          url,
          headers: baseHeaders,
          body,
          region,
          service: "bedrock",
          credentials: auth.credentials,
          now: now(),
        });
        // `host` is signed, but `fetch` sets it itself from the URL and refuses to be told.
        headers = Object.fromEntries(Object.entries(signed).filter(([name]) => name !== "host"));
      }

      const reply = converseResponseSchema.safeParse(
        await postJson(send, { url: url.toString(), headers, body, signal: request.signal }),
      );
      if (!reply.success) {
        throw new ProviderResponseError();
      }
      const text = reply.data.output.message.content.map((block) => block.text ?? "").join("");
      return { text, ...(reply.data.usage === undefined ? {} : { usage: reply.data.usage }) };
    },
  };
}
