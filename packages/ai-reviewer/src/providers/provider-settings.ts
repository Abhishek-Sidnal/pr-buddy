import { z } from "zod";
import { DEFAULT_AI_TIMEOUT_MS, MAX_AI_TIMEOUT_MS } from "../limits.js";
import { providerLabelSchema, type AiToolProvider } from "../provider.js";
import { ANTHROPIC_BASE_URL, createAnthropicProvider } from "./anthropic.js";
import { createBedrockProvider } from "./bedrock.js";
import { createChatCompletionsProvider, OPENAI_BASE_URL } from "./openai.js";

export const PROVIDER_NAMES = [
  "bedrock",
  "anthropic",
  "openai",
  "azure",
  "openai-compatible",
] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

const MAX_SECRET_LENGTH = 4_096;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Where an API is reached. Plain HTTP would send the key and the code in the clear, so it is
 * accepted only for a model running on the same machine. Credentials, a query and a fragment are
 * refused: the adapters build the rest of the address themselves.
 */
function isApiBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const isSafeScheme =
    url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  return (
    isSafeScheme &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

const secretSchema = z.string().min(1).max(MAX_SECRET_LENGTH);

/** What the operator configures. Every field is checked before a provider is built from it. */
export const providerSettingsSchema = z
  .strictObject({
    provider: z.enum(PROVIDER_NAMES),
    /** Published in comments and stored, so it is limited like every provider label. */
    model: providerLabelSchema,
    apiKey: secretSchema.optional(),
    baseUrl: z
      .string()
      .refine(isApiBaseUrl, "must be an https:// URL, or http:// on this machine")
      .transform((value) => value.replace(/\/+$/, ""))
      .optional(),
    region: z
      .string()
      .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/, "must be an AWS region such as us-east-1")
      .optional(),
    accessKeyId: z
      .string()
      .regex(/^[A-Z0-9]{16,128}$/, "must be an AWS access key ID")
      .optional(),
    secretAccessKey: secretSchema.optional(),
    sessionToken: secretSchema.optional(),
    timeoutMs: z.number().int().min(1).max(MAX_AI_TIMEOUT_MS).default(DEFAULT_AI_TIMEOUT_MS),
  })
  .superRefine((settings, context) => {
    const require = (field: keyof typeof settings, message: string): void => {
      if (settings[field] === undefined) {
        context.addIssue({ code: "custom", path: [field], message });
      }
    };
    const { provider } = settings;

    if (provider === "bedrock") {
      require("region", "is required for bedrock");
      const hasAccessKey =
        settings.accessKeyId !== undefined && settings.secretAccessKey !== undefined;
      if (settings.apiKey === undefined && !hasAccessKey) {
        context.addIssue({
          code: "custom",
          path: ["apiKey"],
          message: "bedrock needs a Bedrock API key, or an access key ID with its secret",
        });
      }
    } else if (provider === "azure") {
      require("apiKey", "is required for azure");
      require("baseUrl", "is required for azure");
    } else if (provider === "openai-compatible") {
      require("baseUrl", "is required for openai-compatible");
    } else {
      require("apiKey", `is required for ${provider}`);
    }
  });

export type ProviderSettings = z.infer<typeof providerSettingsSchema>;

export interface ProviderDependencies {
  /** Replaces the global `fetch`; used by tests. */
  readonly fetch?: typeof fetch;
}

/** Builds the provider the settings describe. The settings must have passed the schema. */
export function createProvider(
  settings: ProviderSettings,
  dependencies: ProviderDependencies = {},
): AiToolProvider {
  const { model, apiKey, baseUrl } = settings;
  const shared = dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch };

  switch (settings.provider) {
    case "bedrock":
      return createBedrockProvider({
        ...shared,
        model,
        region: settings.region ?? "",
        auth:
          apiKey === undefined
            ? {
                credentials: {
                  accessKeyId: settings.accessKeyId ?? "",
                  secretAccessKey: settings.secretAccessKey ?? "",
                  ...(settings.sessionToken === undefined
                    ? {}
                    : { sessionToken: settings.sessionToken }),
                },
              }
            : { apiKey },
      });
    case "anthropic":
      return createAnthropicProvider({
        ...shared,
        model,
        apiKey: apiKey ?? "",
        baseUrl: baseUrl ?? ANTHROPIC_BASE_URL,
      });
    case "openai":
    case "azure":
    case "openai-compatible":
      return createChatCompletionsProvider({
        ...shared,
        dialect: settings.provider,
        model,
        ...(apiKey === undefined ? {} : { apiKey }),
        baseUrl: baseUrl ?? OPENAI_BASE_URL,
      });
  }
}
