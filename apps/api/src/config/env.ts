import { z } from "zod";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const MIN_WEBHOOK_SECRET_LENGTH = 16;

function integerSetting(minimum: number, maximum: number, fallback: number): z.ZodType<number> {
  return z.coerce.number().int().min(minimum).max(maximum).default(fallback);
}

/** Accepts a PEM key whose line breaks were written as the two characters `\n`. */
function normalizePrivateKey(value: string): string {
  return value.replaceAll("\\n", "\n").trim();
}

function looksLikePemPrivateKey(value: string): boolean {
  const lines = value.split("\n");
  const first = lines[0] ?? "";
  const last = lines.at(-1) ?? "";
  return (
    lines.length >= 3 &&
    first.startsWith("-----BEGIN ") &&
    first.endsWith("PRIVATE KEY-----") &&
    last.startsWith("-----END ") &&
    last.endsWith("PRIVATE KEY-----")
  );
}

function isPostgresUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    return (protocol === "postgres:" || protocol === "postgresql:") && hostname !== "";
  } catch {
    return false;
  }
}

const environmentSchema = z.object({
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_PRIVATE_KEY: z
    .string()
    .transform(normalizePrivateKey)
    .refine(looksLikePemPrivateKey, "must be a PEM-encoded private key"),
  GITHUB_WEBHOOK_SECRET: z
    .string()
    .min(MIN_WEBHOOK_SECRET_LENGTH, `must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`),
  PORT: integerSetting(1, 65_535, 3_000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  TRUST_PROXY: integerSetting(0, 10, 0),
  REVIEW_CONCURRENCY: integerSetting(1, 32, 2),
  REVIEW_QUEUE_LIMIT: integerSetting(1, 10_000, 100),
  WEBHOOK_RATE_LIMIT: integerSetting(1, 100_000, 300),
  DATABASE_URL: z
    .string()
    .refine(isPostgresUrl, "must be a postgres:// or postgresql:// URL")
    .optional(),
  DATABASE_POOL_SIZE: integerSetting(1, 100, 5),
});

export interface AppConfig {
  readonly github: {
    readonly appId: number;
    readonly privateKey: string;
    readonly webhookSecret: string;
  };
  readonly port: number;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  /** Number of reverse proxies whose `X-Forwarded-For` entry is trusted. */
  readonly trustProxy: number;
  readonly reviewConcurrency: number;
  readonly reviewQueueLimit: number;
  /** Webhook requests allowed per minute from one client address. */
  readonly webhookRateLimit: number;
  /** Absent when the service runs without a database. Contains a password: never log it. */
  readonly database?: {
    readonly url: string;
    readonly poolSize: number;
  };
}

/** Thrown at start-up. Its message names the faulty variables and never contains a value. */
export class EnvironmentError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      ["Invalid environment configuration.", ...issues.map((issue) => `  - ${issue}`)].join("\n"),
    );
    this.name = "EnvironmentError";
    this.issues = issues;
  }
}

/**
 * Reads and validates the service configuration from environment variables.
 * @throws {EnvironmentError}
 */
export function loadConfig(environment: Readonly<Record<string, string | undefined>>): AppConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    // Only the variable name and the constraint are reported: values here are secrets.
    throw new EnvironmentError(
      parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`),
    );
  }
  const values = parsed.data;
  return {
    github: {
      appId: values.GITHUB_APP_ID,
      privateKey: values.GITHUB_PRIVATE_KEY,
      webhookSecret: values.GITHUB_WEBHOOK_SECRET,
    },
    port: values.PORT,
    logLevel: values.LOG_LEVEL,
    trustProxy: values.TRUST_PROXY,
    reviewConcurrency: values.REVIEW_CONCURRENCY,
    reviewQueueLimit: values.REVIEW_QUEUE_LIMIT,
    webhookRateLimit: values.WEBHOOK_RATE_LIMIT,
    ...(values.DATABASE_URL === undefined
      ? {}
      : { database: { url: values.DATABASE_URL, poolSize: values.DATABASE_POOL_SIZE } }),
  };
}
