import type { LogFields, Logger } from "../../src/logger.js";

export interface LogEntry {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly fields: LogFields;
  readonly message: string;
}

export interface RecordingLogger extends Logger {
  readonly entries: LogEntry[];
  /** Everything logged, as one string, for asserting that something was never logged. */
  text(): string;
}

export function createRecordingLogger(): RecordingLogger {
  const entries: LogEntry[] = [];
  const record =
    (level: LogEntry["level"]) =>
    (fields: LogFields, message: string): void => {
      entries.push({ level, fields, message });
    };
  return {
    entries,
    text: () => JSON.stringify(entries),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}
