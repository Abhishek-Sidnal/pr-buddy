import { pino } from "pino";
import type { LOG_LEVELS } from "./config/env.js";

export type LogFields = Readonly<Record<string, unknown>>;

/**
 * The logging the service needs. Callers pass structured fields and a fixed message; they must
 * never pass pull request titles, descriptions, patches or file contents.
 */
export interface Logger {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
}

/** Field names removed from every log line, at any depth, as a last line of defence. */
const REDACTED_PATHS = [
  "authorization",
  "*.authorization",
  "privateKey",
  "*.privateKey",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "webhookSecret",
  "*.webhookSecret",
  "connectionString",
  "*.connectionString",
  "databaseUrl",
  "*.databaseUrl",
  "password",
  "*.password",
  "clientSecret",
  "*.clientSecret",
  "cookie",
  "*.cookie",
  "apiKey",
  "*.apiKey",
  "secretAccessKey",
  "*.secretAccessKey",
  "sessionToken",
  "*.sessionToken",
];

export interface LogDestination {
  write(line: string): void;
}

/**
 * Creates a logger that writes one JSON object per line, to standard output unless another
 * destination is given.
 */
export function createLogger(
  level: (typeof LOG_LEVELS)[number],
  destination?: LogDestination,
): Logger {
  const options = {
    level,
    base: { service: "pr-buddy-api" },
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

const MAX_ERROR_MESSAGE_LENGTH = 500;
const MAX_ERROR_CODE_LENGTH = 40;

/**
 * Reduces an error to fields that are safe to log: its name, a bounded message and, for HTTP
 * errors, the status. Stack traces and attached request or response objects are dropped.
 */
export function describeError(error: unknown): LogFields {
  if (!(error instanceof Error)) {
    return { errorName: "NonError" };
  }
  const status: unknown = "status" in error ? error.status : undefined;
  // Database and network errors identify themselves with a short code, such as "23505".
  const code: unknown = "code" in error ? error.code : undefined;
  return {
    errorName: error.name,
    errorMessage: error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof code === "string" ? { errorCode: code.slice(0, MAX_ERROR_CODE_LENGTH) } : {}),
  };
}
