export interface RetryOptions {
  /** Total tries, including the first. */
  readonly attempts: number;
  /** Wait before the second try after a transient failure; doubled before each later one. */
  readonly baseDelayMs: number;
  /**
   * Longest wait accepted for a rate limit to lift. If GitHub asks for longer, the call fails at
   * once instead of holding a review slot.
   */
  readonly maxRateLimitDelayMs: number;
  /** Replaceable so tests do not wait. */
  readonly sleep?: (delayMs: number) => Promise<void>;
  /** Replaceable so tests control time. */
  readonly now?: () => number;
}

export const DEFAULT_RETRY: RetryOptions = {
  attempts: 3,
  baseDelayMs: 500,
  maxRateLimitDelayMs: 60_000,
};

const MS_PER_SECOND = 1_000;
const TOO_MANY_REQUESTS = 429;
const FORBIDDEN = 403;
const SERVER_ERROR = 500;
/** GitHub asks for at least a minute when a secondary rate limit gives no explicit wait. */
const SECONDARY_RATE_LIMIT_DELAY_MS = 60_000;

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function statusOf(error: unknown): unknown {
  return isRecord(error) ? error["status"] : undefined;
}

/** Reads a response header from an HTTP error shaped like Octokit's, if it has one. */
function headerOf(error: unknown, name: string): string | undefined {
  if (!isRecord(error) || !isRecord(error["response"])) {
    return undefined;
  }
  const headers = error["response"]["headers"];
  const value = isRecord(headers) ? headers[name] : undefined;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function messageOf(error: unknown): string {
  return isRecord(error) && typeof error["message"] === "string" ? error["message"] : "";
}

/**
 * True for failures worth retrying soon: no HTTP status at all (the network failed) or a server
 * error.
 */
export function isTransientHttpError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const status = statusOf(error);
  return typeof status === "number" ? status >= SERVER_ERROR : status === undefined;
}

/**
 * True when GitHub refused a request because of a primary or secondary rate limit: a 429, or a
 * 403 that carries a retry time, an exhausted quota or a rate-limit message. An ordinary 403,
 * such as a missing permission, is not one.
 */
export function isRateLimitError(error: unknown): boolean {
  const status = statusOf(error);
  if (status === TOO_MANY_REQUESTS) {
    return true;
  }
  return (
    status === FORBIDDEN &&
    (headerOf(error, "retry-after") !== undefined ||
      headerOf(error, "x-ratelimit-remaining") === "0" ||
      messageOf(error).toLowerCase().includes("rate limit"))
  );
}

/** How long GitHub asks the caller to wait before trying again after a rate limit. */
export function rateLimitDelayMs(error: unknown, now: number): number {
  const retryAfterSeconds = Number(headerOf(error, "retry-after"));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * MS_PER_SECOND;
  }
  const resetEpochSeconds = Number(headerOf(error, "x-ratelimit-reset"));
  if (headerOf(error, "x-ratelimit-remaining") === "0" && Number.isFinite(resetEpochSeconds)) {
    // One extra second, because the reset time is given in whole seconds.
    return Math.max(0, resetEpochSeconds * MS_PER_SECOND - now) + MS_PER_SECOND;
  }
  return SECONDARY_RATE_LIMIT_DELAY_MS;
}

/** The wait before the next attempt, or `undefined` if the error should not be retried. */
function retryDelayMs(error: unknown, attempt: number, options: RetryOptions): number | undefined {
  if (isRateLimitError(error)) {
    const delayMs = rateLimitDelayMs(error, (options.now ?? Date.now)());
    return delayMs <= options.maxRateLimitDelayMs ? delayMs : undefined;
  }
  return isTransientHttpError(error) ? options.baseDelayMs * 2 ** (attempt - 1) : undefined;
}

/**
 * Runs `operation`, trying again after transient failures (with exponential back-off) and after
 * rate limits (after the wait GitHub asks for, if it is short enough). Other errors, and the
 * last error once the attempts are used up, are rethrown unchanged.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMs =
        attempt < options.attempts ? retryDelayMs(error, attempt, options) : undefined;
      if (delayMs === undefined) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}
