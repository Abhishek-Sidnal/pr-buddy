import { z } from "zod";
import { MAX_PROVIDER_LABEL_LENGTH } from "./limits.js";

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
