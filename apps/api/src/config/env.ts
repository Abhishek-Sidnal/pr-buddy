import { providerSettingsSchema, type ProviderSettings } from "@pr-buddy/ai-reviewer";
import { z } from "zod";
import { decodeMasterKey } from "../modules/ai-keys/secret-cipher.js";

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

/**
 * Where people reach the service. Plain HTTP would send the session cookie in the clear, so it
 * is accepted only for the local machine. A path, query or credentials are refused: cookies and
 * the callback are built from the origin alone.
 */
function isHttpsLink(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "";
}

const MAX_OPERATOR_NAME_LENGTH = 100;
const MAX_OPERATOR_LINK_LENGTH = 500;
/** Deliberately narrow: letters, digits and a few signs. No scheme, no query, nothing to escape. */
const EMAIL_ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

const operatorLinkSetting = z
  .string()
  .max(MAX_OPERATOR_LINK_LENGTH)
  .refine(isHttpsLink, "must be an https:// address");

/** Who runs this deployment, as the operator chose to say it. `null` means they did not say. */
export interface OperatorInfo {
  readonly name: string | null;
  /** An email address or an https:// address. */
  readonly contact: string | null;
  readonly privacyUrl: string | null;
  readonly termsUrl: string | null;
}

function isPublicUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const isSafeScheme = url.protocol === "https:" || (url.protocol === "http:" && isLocal);
  return (
    isSafeScheme &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    (url.pathname === "/" || url.pathname === "")
  );
}

/** A master key for stored secrets: 32 random bytes, written in base64. */
const masterKeySetting = z
  .string()
  .transform((value) => decodeMasterKey(value))
  .refine((key): key is Buffer => key !== undefined, "must be 32 random bytes in base64");

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
  REVIEW_QUEUE_LIMIT_PER_INSTALLATION: integerSetting(1, 10_000, 20),
  WEBHOOK_RATE_LIMIT: integerSetting(1, 100_000, 300),
  DATABASE_URL: z
    .string()
    .refine(isPostgresUrl, "must be a postgres:// or postgresql:// URL")
    .optional(),
  DATABASE_POOL_SIZE: integerSetting(1, 100, 5),
  REVIEW_RETENTION_DAYS: integerSetting(0, 3_650, 365),
  SECRETS_ENCRYPTION_KEY: masterKeySetting.optional(),
  SECRETS_ENCRYPTION_KEY_PREVIOUS: masterKeySetting.optional(),
  GITHUB_CLIENT_ID: z.string().min(1).max(100).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).max(200).optional(),
  /**
   * The app's name as it appears in github.com/apps/<slug>. GitHub allows lower-case letters,
   * digits and hyphens there; nothing else may reach the Install link.
   */
  GITHUB_APP_SLUG: z
    .string()
    .regex(
      /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/,
      "must be the app's name in github.com/apps/<name>",
    )
    .optional(),
  PUBLIC_URL: z
    .string()
    .refine(isPublicUrl, "must be an https:// origin, or http://localhost for development")
    .optional(),
  // Who runs this deployment, shown on a public page. Each is text or a link the operator
  // chose; none may carry anything a browser would run (D-090).
  OPERATOR_NAME: z
    .string()
    .min(1)
    .max(MAX_OPERATOR_NAME_LENGTH)
    .regex(/^[^\p{Cc}]+$/u, "must not contain control characters")
    .optional(),
  OPERATOR_CONTACT: z
    .string()
    .max(MAX_OPERATOR_LINK_LENGTH)
    .refine(
      (value) => EMAIL_ADDRESS.test(value) || isHttpsLink(value),
      "must be an email address or an https:// address",
    )
    .optional(),
  OPERATOR_PRIVACY_URL: operatorLinkSetting.optional(),
  OPERATOR_TERMS_URL: operatorLinkSetting.optional(),
  // GitHub's numeric user IDs of the people who run this deployment, separated by commas.
  // IDs and not logins: a login can be given up and taken by someone else (D-093).
  OPERATOR_GITHUB_USER_IDS: z
    .string()
    .regex(
      /^[1-9]\d{0,14}(?:,[1-9]\d{0,14}){0,19}$/,
      "must be up to 20 GitHub user IDs separated by commas, without spaces",
    )
    .transform((value) => [...new Set(value.split(",").map(Number))])
    .optional(),
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
  /** Reviews of one installation that may wait. */
  readonly reviewQueueLimitPerInstallation: number;
  /** Webhook requests allowed per minute from one client address. */
  readonly webhookRateLimit: number;
  /** Reviews older than this many days are deleted. Zero keeps every review. */
  readonly reviewRetentionDays: number;
  /** Absent when the service runs without a database. Contains a password: never log it. */
  readonly database?: {
    readonly url: string;
    readonly poolSize: number;
  };
  /**
   * Master keys for secrets stored for customers. Absent when none is configured, and then no
   * customer secret can be stored. Never log it.
   */
  readonly secretKeys?: {
    readonly current: Buffer;
    /** Still accepted for decryption, so that the current key can be rotated in. */
    readonly previous: readonly Buffer[];
  };
  /** Absent when AI review is off. Contains secrets: never log it. */
  readonly ai?: ProviderSettings;
  /** Absent when the dashboard is off. Contains a secret: never log it. */
  readonly dashboard?: {
    readonly clientId: string;
    readonly clientSecret: string;
    /** The origin people use to reach the service, without a trailing slash. */
    readonly publicUrl: string;
    /** The app's name in github.com/apps/<slug>. Without it nobody is offered an Install link. */
    readonly appSlug?: string;
    readonly operator: OperatorInfo;
    /** GitHub user IDs that may see the operator's view. Empty: nobody, and it does not exist. */
    readonly operatorUserIds: readonly number[];
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

/** Which environment variable holds each provider setting. */
const AI_VARIABLES = {
  provider: "AI_PROVIDER",
  model: "AI_MODEL",
  apiKey: "AI_API_KEY",
  baseUrl: "AI_BASE_URL",
  region: "AWS_REGION",
  accessKeyId: "AWS_ACCESS_KEY_ID",
  secretAccessKey: "AWS_SECRET_ACCESS_KEY",
  sessionToken: "AWS_SESSION_TOKEN",
  timeoutMs: "AI_TIMEOUT_MS",
} as const;

/**
 * AI review is off unless `AI_PROVIDER` is set. When it is, everything that provider needs must
 * be right, or the service stops here: finding out at the first pull request would be worse.
 */
function readAiSettings(
  environment: Readonly<Record<string, string | undefined>>,
): ProviderSettings | undefined {
  // An empty value is how a variable is usually "unset" in a compose or .env file.
  const read = (name: string): string | undefined => {
    const value = environment[name];
    return value === undefined || value === "" ? undefined : value;
  };
  if (read(AI_VARIABLES.provider) === undefined) {
    return undefined;
  }

  const timeout = read(AI_VARIABLES.timeoutMs);
  const raw: Record<string, unknown> = {};
  for (const [field, variable] of Object.entries(AI_VARIABLES)) {
    const value = read(variable);
    if (value !== undefined) {
      raw[field] = value;
    }
  }
  // AWS's own name for a Bedrock API key is honoured when the generic one is not set.
  raw["apiKey"] ??= read("AWS_BEARER_TOKEN_BEDROCK");
  if (raw["apiKey"] === undefined) {
    delete raw["apiKey"];
  }
  if (timeout !== undefined) {
    raw["timeoutMs"] = Number(timeout);
  }

  const parsed = providerSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    // Only the variable name and the constraint are reported: values here are secrets.
    throw new EnvironmentError(
      parsed.error.issues.map((issue) => {
        const field = String(issue.path[0]) as keyof typeof AI_VARIABLES;
        return `${AI_VARIABLES[field]}: ${issue.message}`;
      }),
    );
  }
  return parsed.data;
}

const DASHBOARD_VARIABLES = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "PUBLIC_URL"] as const;

/**
 * The dashboard is all or nothing: a sign-in that is half configured should stop the service at
 * start-up, not fail for the first visitor. It also needs the database, where sessions and the
 * history live.
 */
function readDashboardSettings(values: z.infer<typeof environmentSchema>): AppConfig["dashboard"] {
  const missing = DASHBOARD_VARIABLES.filter((name) => values[name] === undefined);
  if (missing.length === DASHBOARD_VARIABLES.length) {
    return undefined;
  }
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, PUBLIC_URL, DATABASE_URL } = values;
  if (
    GITHUB_CLIENT_ID === undefined ||
    GITHUB_CLIENT_SECRET === undefined ||
    PUBLIC_URL === undefined
  ) {
    throw new EnvironmentError(
      missing.map((name) => `${name}: is required when the other dashboard variables are set`),
    );
  }
  if (DATABASE_URL === undefined) {
    throw new EnvironmentError(["DATABASE_URL: is required for the dashboard"]);
  }
  return {
    clientId: GITHUB_CLIENT_ID,
    clientSecret: GITHUB_CLIENT_SECRET,
    publicUrl: new URL(PUBLIC_URL).origin,
    ...(values.GITHUB_APP_SLUG === undefined ? {} : { appSlug: values.GITHUB_APP_SLUG }),
    operator: {
      name: values.OPERATOR_NAME ?? null,
      contact: values.OPERATOR_CONTACT ?? null,
      privacyUrl: values.OPERATOR_PRIVACY_URL ?? null,
      termsUrl: values.OPERATOR_TERMS_URL ?? null,
    },
    operatorUserIds: values.OPERATOR_GITHUB_USER_IDS ?? [],
  };
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
  const dashboard = readDashboardSettings(values);
  if (
    values.SECRETS_ENCRYPTION_KEY_PREVIOUS !== undefined &&
    values.SECRETS_ENCRYPTION_KEY === undefined
  ) {
    throw new EnvironmentError([
      "SECRETS_ENCRYPTION_KEY: is required when SECRETS_ENCRYPTION_KEY_PREVIOUS is set",
    ]);
  }
  const ai = readAiSettings(environment);
  return {
    ...(dashboard === undefined ? {} : { dashboard }),
    ...(ai === undefined ? {} : { ai }),
    ...(values.SECRETS_ENCRYPTION_KEY === undefined
      ? {}
      : {
          secretKeys: {
            current: values.SECRETS_ENCRYPTION_KEY,
            previous:
              values.SECRETS_ENCRYPTION_KEY_PREVIOUS === undefined
                ? []
                : [values.SECRETS_ENCRYPTION_KEY_PREVIOUS],
          },
        }),
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
    reviewQueueLimitPerInstallation: values.REVIEW_QUEUE_LIMIT_PER_INSTALLATION,
    webhookRateLimit: values.WEBHOOK_RATE_LIMIT,
    reviewRetentionDays: values.REVIEW_RETENTION_DAYS,
    ...(values.DATABASE_URL === undefined
      ? {}
      : { database: { url: values.DATABASE_URL, poolSize: values.DATABASE_POOL_SIZE } }),
  };
}

/**
 * Settings that are each valid but risky together. They do not stop the service: it cannot see
 * the network in front of it, so it says what it suspects and lets the operator decide.
 */
export function findConfigurationWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];
  const isPublicHttps = config.dashboard?.publicUrl.startsWith("https://") === true;

  if (isPublicHttps && config.trustProxy === 0) {
    warnings.push(
      "PUBLIC_URL is HTTPS but TRUST_PROXY is 0. Behind a proxy, every visitor then shares one " +
        "rate limit. Set TRUST_PROXY to the number of proxies in front of the service.",
    );
  }
  if (
    config.dashboard !== undefined &&
    (config.dashboard.operator.name === null || config.dashboard.operator.contact === null)
  ) {
    warnings.push(
      "OPERATOR_NAME and OPERATOR_CONTACT are not both set. The public privacy page then says " +
        "that the operator of this service has not published who they are.",
    );
  }
  if (config.dashboard !== undefined && config.dashboard.appSlug === undefined) {
    warnings.push(
      "GITHUB_APP_SLUG is not set. The dashboard cannot offer an Install button, so a new " +
        "visitor has no way to start from it. Set it to the app's name in github.com/apps/<name>.",
    );
  }
  if (config.database !== undefined && /[?&]sslmode=disable\b/.test(config.database.url)) {
    warnings.push(
      "DATABASE_URL turns encryption off. That is safe only on a private network such as a " +
        "Compose network.",
    );
  }
  return warnings;
}
