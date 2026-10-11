import { z } from "zod";
import type { AiMessage, AiResponse, AiToolProvider, AiTurn } from "../provider.js";
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

/**
 * The parts of a Converse reply that are used: text, and requests for tools. Other blocks, such
 * as reasoning, are skipped.
 */
const converseResponseSchema = z.object({
  output: z.object({
    message: z.object({
      content: z.array(
        z.object({
          text: z.string().optional(),
          toolUse: z
            .object({ toolUseId: z.string(), name: z.string(), input: z.unknown().optional() })
            .optional(),
        }),
      ),
    }),
  }),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
});

type ConverseResponse = z.infer<typeof converseResponseSchema>;

function textOf(reply: ConverseResponse): string {
  return reply.output.message.content.map((block) => block.text ?? "").join("");
}

function usageOf(reply: ConverseResponse): object {
  return reply.usage === undefined ? {} : { usage: reply.usage };
}

/** A conversation in Converse's form. An empty text block is not accepted, so none is sent. */
function toMessages(messages: readonly AiMessage[]): unknown[] {
  return messages.map((message) => {
    switch (message.role) {
      case "user":
        return { role: "user", content: [{ text: message.text }] };
      case "assistant":
        return {
          role: "assistant",
          content: [
            ...(message.text === "" ? [] : [{ text: message.text }]),
            ...message.toolCalls.map((call) => ({
              toolUse: { toolUseId: call.id, name: call.name, input: call.input ?? {} },
            })),
          ],
        };
      case "tool":
        return {
          role: "user",
          content: [
            ...message.results.map((result) => ({
              toolResult: {
                toolUseId: result.id,
                content: [{ text: result.text }],
                status: result.isRefused ? "error" : "success",
              },
            })),
            ...(message.note === undefined ? [] : [{ text: message.note }]),
          ],
        };
    }
  });
}

/**
 * AWS Bedrock, through its Converse API: one request shape for every model family, so the same
 * adapter serves Anthropic, Amazon, Meta and other models hosted there.
 */
export function createBedrockProvider(options: BedrockOptions): AiToolProvider {
  const { model, region, auth } = options;
  const send = options.fetch ?? fetch;
  const now = options.now ?? ((): Date => new Date());
  // A model ID contains ":" and an ARN contains "/"; both must be encoded to stay one segment.
  const url = new URL(
    `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`,
  );

  const post = async (content: object, signal: AbortSignal): Promise<ConverseResponse> => {
    const body = JSON.stringify(content);
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
      await postJson(send, { url: url.toString(), headers, body, signal }),
    );
    if (!reply.success) {
      throw new ProviderResponseError();
    }
    return reply.data;
  };

  return {
    name: "bedrock",
    model,

    async complete(request): Promise<AiResponse> {
      const reply = await post(
        {
          system: [{ text: request.system }],
          messages: [{ role: "user", content: [{ text: request.user }] }],
          inferenceConfig: { maxTokens: request.maxOutputTokens },
        },
        request.signal,
      );
      return { text: textOf(reply), ...usageOf(reply) };
    },

    // Converse cannot be told "no tools now", so `toolChoice` is not sent. The loop's closing
    // message asks for the answer, and a tool request in reply to it is ignored.
    async converse(request): Promise<AiTurn> {
      const reply = await post(
        {
          system: [{ text: request.system }],
          messages: toMessages(request.messages),
          inferenceConfig: { maxTokens: request.maxOutputTokens },
          toolConfig: {
            tools: request.tools.map((tool) => ({
              toolSpec: {
                name: tool.name,
                description: tool.description,
                inputSchema: { json: tool.inputSchema },
              },
            })),
          },
        },
        request.signal,
      );
      return {
        text: textOf(reply),
        toolCalls: reply.output.message.content.flatMap((block) =>
          block.toolUse === undefined
            ? []
            : [
                {
                  id: block.toolUse.toolUseId,
                  name: block.toolUse.name,
                  input: block.toolUse.input,
                },
              ],
        ),
        ...usageOf(reply),
      };
    },
  };
}
