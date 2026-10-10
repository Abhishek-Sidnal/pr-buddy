import { providerSettingsSchema, type ProviderSettings } from "@pr-buddy/ai-reviewer";
import { z } from "zod";
import type { Database, Queryable } from "../../database/database.js";
import { toBigintArrayLiteral } from "../auth/postgres-session-store.js";
import type { SecretCipher } from "./secret-cipher.js";

/**
 * Providers a customer may choose. Each has its host fixed in code: a customer never supplies an
 * address, so the service cannot be pointed at its own network (D-074).
 */
export const CUSTOMER_PROVIDERS = ["anthropic", "openai", "bedrock", "azure"] as const;
export type CustomerProvider = (typeof CUSTOMER_PROVIDERS)[number];

const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 4_096;
const KEY_HINT_LENGTH = 4;

/**
 * The name of an Azure resource. It becomes the first label of a host name, so it may hold
 * nothing that could end the label or the host: no dot, slash, colon or `@` (D-080).
 */
const AZURE_RESOURCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const AZURE_ADDRESS_START = "https://";
const AZURE_ADDRESS_END = ".openai.azure.com/openai/v1";

/** Where an Azure resource is reached. The name must have passed `AZURE_RESOURCE_PATTERN`. */
function azureBaseUrl(resource: string): string {
  return `${AZURE_ADDRESS_START}${resource}${AZURE_ADDRESS_END}`;
}

/**
 * The Azure resource a set of settings points at, or `null` for another provider.
 * @throws {Error} if Azure settings carry an address this module did not build.
 */
function azureResourceOf(settings: ProviderSettings): string | null {
  if (settings.provider !== "azure") {
    return null;
  }
  const address = settings.baseUrl ?? "";
  const resource = address.slice(AZURE_ADDRESS_START.length, -AZURE_ADDRESS_END.length);
  if (!AZURE_RESOURCE_PATTERN.test(resource) || address !== azureBaseUrl(resource)) {
    throw new Error("The Azure settings do not name a resource.");
  }
  return resource;
}

/** What an owner submits. The fields are checked again by the provider's own settings schema. */
export const aiKeyInputSchema = z
  .strictObject({
    provider: z.enum(CUSTOMER_PROVIDERS),
    model: z.string().min(1).max(200),
    region: z.string().max(40).optional(),
    resource: z.string().max(64).optional(),
    // No surrounding space and nothing that is not printable: such a key is a pasting mistake.
    apiKey: z
      .string()
      .min(MIN_KEY_LENGTH)
      .max(MAX_KEY_LENGTH)
      .regex(/^[\x21-\x7e]+$/, "must not contain spaces or control characters"),
  })
  .transform((input, context): ProviderSettings => {
    const isAzure = input.provider === "azure";
    if (isAzure && !AZURE_RESOURCE_PATTERN.test(input.resource ?? "")) {
      context.addIssue({
        code: "custom",
        path: ["resource"],
        message: "must be the name of an Azure resource",
      });
      return z.NEVER;
    }
    // The provider's schema owns the rules for models and regions; a region is passed on only
    // for Bedrock. An address is never taken from the input: for Azure it is built here from
    // the resource's name, and no other provider gets one.
    const settings = providerSettingsSchema.safeParse({
      provider: input.provider,
      model: input.model,
      apiKey: input.apiKey,
      ...(input.provider === "bedrock" ? { region: input.region } : {}),
      ...(isAzure ? { baseUrl: azureBaseUrl(input.resource ?? "") } : {}),
    });
    if (!settings.success) {
      for (const issue of settings.error.issues) {
        context.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
      return z.NEVER;
    }
    return settings.data;
  });

/** What may be shown about a stored key. The key itself is not part of it. */
export interface AiKeySummary {
  readonly installationId: number;
  readonly provider: CustomerProvider;
  readonly model: string;
  readonly region: string | null;
  /** The Azure resource's name; `null` for every other provider. */
  readonly resource: string | null;
  /** The last four characters of the key. */
  readonly keyHint: string;
  /** ISO 8601. */
  readonly updatedAt: string;
}

/** Keeps each installation's AI provider and key. Every method is keyed by the installation. */
export interface AiKeyStore {
  /** Summaries for the given installations; installations without a key are absent. */
  list(installationIds: readonly number[]): Promise<readonly AiKeySummary[]>;
  /** Stores or replaces an installation's key and records who did it. */
  save(installationId: number, settings: ProviderSettings, userId: number): Promise<AiKeySummary>;
  /** Removes an installation's key and records who did it. Returns whether there was one. */
  remove(installationId: number, userId: number): Promise<boolean>;
  /**
   * The provider settings to review with, key included, or `undefined` if the installation has
   * none. For the review service only; the result must not be logged or returned to anyone.
   * @throws {SecretDecryptionError} if the stored key cannot be decrypted.
   */
  load(installationId: number): Promise<ProviderSettings | undefined>;
}

interface KeyRow {
  readonly installation_id: string;
  readonly provider: CustomerProvider;
  readonly model: string;
  readonly region: string | null;
  readonly resource: string | null;
  readonly key_hint: string;
  readonly updated_at: Date;
}

function toSummary(row: KeyRow): AiKeySummary {
  return {
    installationId: Number(row.installation_id),
    provider: row.provider,
    model: row.model,
    region: row.region,
    resource: row.resource,
    keyHint: row.key_hint,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** What a ciphertext is bound to. A key copied to another installation's row will not decrypt. */
function contextOf(installationId: number, provider: string): string {
  return `installation-ai-key:${installationId}:${provider}`;
}

async function recordAudit(
  transaction: Queryable,
  installationId: number,
  userId: number,
  action: "ai-key-saved" | "ai-key-removed",
): Promise<void> {
  await transaction.query(
    "INSERT INTO audit_events (installation_id, user_id, action) VALUES ($1, $2, $3)",
    [installationId, userId, action],
  );
}

/** An AI key store backed by PostgreSQL. Keys are encrypted before they reach a statement. */
export function createPostgresAiKeyStore(database: Database, cipher: SecretCipher): AiKeyStore {
  return {
    async list(installationIds) {
      const result = await database.query<KeyRow>(
        `SELECT installation_id, provider, model, region, resource, key_hint, updated_at
         FROM installation_ai_keys
         WHERE installation_id = ANY($1::bigint[])
         ORDER BY installation_id`,
        [toBigintArrayLiteral(installationIds)],
      );
      return result.rows.map(toSummary);
    },

    save(installationId, settings, userId) {
      const apiKey = settings.apiKey ?? "";
      const resource = azureResourceOf(settings);
      const encrypted = cipher.encrypt(apiKey, contextOf(installationId, settings.provider));
      return database.transaction(async (transaction) => {
        const result = await transaction.query<KeyRow>(
          `INSERT INTO installation_ai_keys
             (installation_id, provider, model, region, key_ciphertext, key_nonce, key_id,
              key_hint, updated_by, resource)
           VALUES ($1, $2, $3, $4, decode($5, 'base64'), decode($6, 'base64'), $7, $8, $9, $10)
           ON CONFLICT (installation_id) DO UPDATE
             SET provider       = EXCLUDED.provider,
                 model          = EXCLUDED.model,
                 region         = EXCLUDED.region,
                 resource       = EXCLUDED.resource,
                 key_ciphertext = EXCLUDED.key_ciphertext,
                 key_nonce      = EXCLUDED.key_nonce,
                 key_id         = EXCLUDED.key_id,
                 key_hint       = EXCLUDED.key_hint,
                 updated_by     = EXCLUDED.updated_by,
                 updated_at     = now()
           RETURNING installation_id, provider, model, region, resource, key_hint, updated_at`,
          [
            installationId,
            settings.provider,
            settings.model,
            settings.region ?? null,
            encrypted.ciphertext.toString("base64"),
            encrypted.nonce.toString("base64"),
            encrypted.keyId,
            apiKey.slice(-KEY_HINT_LENGTH),
            userId,
            resource,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new Error("The stored key was not returned.");
        }
        await recordAudit(transaction, installationId, userId, "ai-key-saved");
        return toSummary(row);
      });
    },

    remove(installationId, userId) {
      return database.transaction(async (transaction) => {
        const deleted = await transaction.query(
          "DELETE FROM installation_ai_keys WHERE installation_id = $1",
          [installationId],
        );
        if (deleted.rowCount === 0) {
          return false;
        }
        await recordAudit(transaction, installationId, userId, "ai-key-removed");
        return true;
      });
    },

    async load(installationId) {
      const result = await database.query<{
        provider: CustomerProvider;
        model: string;
        region: string | null;
        resource: string | null;
        ciphertext: string;
        nonce: string;
        key_id: string;
      }>(
        `SELECT provider, model, region, resource, encode(key_ciphertext, 'base64') AS ciphertext,
                encode(key_nonce, 'base64') AS nonce, key_id
         FROM installation_ai_keys
         WHERE installation_id = $1`,
        [installationId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return undefined;
      }
      const apiKey = cipher.decrypt(
        {
          ciphertext: Buffer.from(row.ciphertext, "base64"),
          nonce: Buffer.from(row.nonce, "base64"),
          keyId: row.key_id,
        },
        contextOf(installationId, row.provider),
      );
      // Read back through the same schema that accepted it, so a row edited by hand cannot
      // carry an address or a malformed region or resource name into a request.
      return aiKeyInputSchema.parse({
        provider: row.provider,
        model: row.model,
        apiKey,
        ...(row.region === null ? {} : { region: row.region }),
        ...(row.resource === null ? {} : { resource: row.resource }),
      });
    },
  };
}
