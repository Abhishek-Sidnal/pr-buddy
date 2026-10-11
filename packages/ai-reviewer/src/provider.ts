import { z } from "zod";
import {
  MAX_PROVIDER_LABEL_LENGTH,
  MAX_TOOL_CALL_ID_LENGTH,
  MAX_TOOL_NAME_LENGTH,
} from "./limits.js";

/** What a provider is asked to complete. */
export interface AiRequest {
  /** Fixed instructions. Contains nothing from the pull request. */
  readonly system: string;
  /** The pull request content, as one JSON document. */
  readonly user: string;
  /** The reply must stay within this many tokens. */
  readonly maxOutputTokens: number;
  /** Aborted when the time limit passes; a provider should cancel its request. */
  readonly signal: AbortSignal;
}

export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AiResponse {
  /** The model's reply, unprocessed. */
  readonly text: string;
  /** Token counts, when the provider reports them. */
  readonly usage?: AiUsage;
}

/**
 * A service that runs a language model. Implementations hold their own credentials and must not
 * put them, or any part of the request, in the errors they throw.
 */
export interface AiProvider {
  /** Short name of the service, for example its company. Published and stored. */
  readonly name: string;
  /** The model that answers. Published and stored. */
  readonly model: string;
  complete(request: AiRequest): Promise<AiResponse>;
}

/** Names are published in comments, so they are limited to characters with no meaning there. */
export const providerLabelSchema = z
  .string()
  .max(MAX_PROVIDER_LABEL_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "must be letters, digits and . _ : / - only");

const tokenCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * A provider's answer is checked like any other outside input before it is used. Usage that
 * is missing or malformed is dropped; it is not a reason to discard the reply.
 */
export const aiResponseSchema = z.object({
  text: z.string(),
  usage: z
    .object({ inputTokens: tokenCountSchema, outputTokens: tokenCountSchema })
    .optional()
    .catch(undefined),
});

/** A tool as a model is told about it. */
export interface AiToolDefinition {
  readonly name: string;
  readonly description: string;
  /** A JSON Schema object. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** One request by a model to run a tool. Every field came from the model. */
export interface AiToolCall {
  /** The provider's identifier, which the answer must carry back. */
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** What a tool answered to one request. */
export interface AiToolCallResult {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly isRefused: boolean;
}

/** One entry of a conversation, in a form no provider owns. Adapters translate it. */
export type AiMessage =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text: string;
      readonly toolCalls: readonly AiToolCall[];
    }
  | {
      readonly role: "tool";
      readonly results: readonly AiToolCallResult[];
      /** Text from the loop itself that goes with the answers, in the same turn. */
      readonly note?: string;
    };

/** What a provider is asked for one step of a conversation with tools. */
export interface AiTurnRequest {
  /** Fixed instructions. Contains nothing from the pull request. */
  readonly system: string;
  /** The conversation so far, oldest first. It starts with a user message. */
  readonly messages: readonly AiMessage[];
  /**
   * The tools the model may ask for. They are sent on every step, the last one too: providers
   * refuse a conversation that holds tool requests without the tools' definitions.
   */
  readonly tools: readonly AiToolDefinition[];
  /** "none" asks for an answer now. A provider with no such setting sends the tools as usual. */
  readonly toolChoice: "auto" | "none";
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}

/** A model's reply to one step: text, requests for tools, or both. */
export interface AiTurn {
  readonly text: string;
  readonly toolCalls: readonly AiToolCall[];
  readonly usage?: AiUsage;
}

/**
 * A provider that can hold a conversation in which the model asks for tools. Only runner mode
 * uses it; the hosted reviewer makes one request with `complete` and offers no tools.
 */
export interface AiToolProvider extends AiProvider {
  converse(request: AiTurnRequest): Promise<AiTurn>;
}

/** A reply is checked like any other outside input. Malformed usage is dropped, not fatal. */
export const aiTurnSchema = z.object({
  text: z.string(),
  toolCalls: z.array(
    z.object({
      id: z.string().min(1).max(MAX_TOOL_CALL_ID_LENGTH),
      name: z.string().min(1).max(MAX_TOOL_NAME_LENGTH),
      input: z.unknown().optional(),
    }),
  ),
  usage: z
    .object({ inputTokens: tokenCountSchema, outputTokens: tokenCountSchema })
    .optional()
    .catch(undefined),
});
