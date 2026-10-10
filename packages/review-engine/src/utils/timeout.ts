export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms.`);
    this.name = "TimeoutError";
  }
}

/**
 * Runs `operation` and rejects with `TimeoutError` if it has not settled within `timeoutMs`.
 * A synchronous throw from `operation` becomes a rejection. The operation is not cancelled:
 * synchronous code that never yields cannot be interrupted.
 */
export async function withTimeout<T>(
  operation: () => T | Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
