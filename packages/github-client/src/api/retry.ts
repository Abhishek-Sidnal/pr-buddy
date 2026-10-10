export interface RetryOptions {
  /** Total tries, including the first. */
  readonly attempts: number;
  /** Wait before the second try; doubled before each later one. */
  readonly baseDelayMs: number;
  /** Replaceable so tests do not wait. */
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export const DEFAULT_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 500 };

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

/**
 * Runs `operation`, trying again with exponential back-off while `isRetryable` says the failure
 * is transient. The last error is rethrown unchanged.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: RetryOptions = DEFAULT_RETRY,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= options.attempts || !isRetryable(error)) {
        throw error;
      }
      await sleep(options.baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

/**
 * True for failures worth retrying: no HTTP status at all (the network failed) or a server
 * error. Client errors, including rate limits, are not retried here.
 */
export function isTransientHttpError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const status: unknown = "status" in error ? error.status : undefined;
  return typeof status === "number" ? status >= 500 : status === undefined;
}
