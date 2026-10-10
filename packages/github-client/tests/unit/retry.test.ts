import { describe, expect, it } from "vitest";
import {
  isRateLimitError,
  isTransientHttpError,
  rateLimitDelayMs,
  withRetry,
  type RetryOptions,
} from "../../src/api/retry.js";

const NOW = 1_800_000_000_000;

/** An error shaped like the ones Octokit throws for HTTP failures. */
function httpError(
  status: number,
  headers: Record<string, string | number> = {},
  message = `HTTP ${status}`,
): Error {
  return Object.assign(new Error(message), { status, response: { headers } });
}

/** Builds an operation that fails with each error in turn and then returns "done". */
function failingWith(...errors: Error[]): { run: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    run: () => {
      const error = errors[calls];
      calls += 1;
      return error === undefined ? Promise.resolve("done") : Promise.reject(error);
    },
    calls: () => calls,
  };
}

function retryOptions(overrides: Partial<RetryOptions> = {}): RetryOptions & { delays: number[] } {
  const delays: number[] = [];
  return {
    attempts: 3,
    baseDelayMs: 100,
    maxRateLimitDelayMs: 60_000,
    now: () => NOW,
    sleep: (delayMs) => {
      delays.push(delayMs);
      return Promise.resolve();
    },
    delays,
    ...overrides,
  };
}

describe("withRetry", () => {
  it("returns the result of an operation that succeeds at once", async () => {
    const operation = failingWith();
    const options = retryOptions();

    await expect(withRetry(operation.run, options)).resolves.toBe("done");
    expect(operation.calls()).toBe(1);
    expect(options.delays).toEqual([]);
  });

  it("tries again after transient failures, doubling the wait", async () => {
    const operation = failingWith(httpError(502), httpError(503));
    const options = retryOptions();

    await expect(withRetry(operation.run, options)).resolves.toBe("done");
    expect(operation.calls()).toBe(3);
    expect(options.delays).toEqual([100, 200]);
  });

  it("gives up after the configured number of attempts and rethrows the last error", async () => {
    const last = httpError(500);
    const operation = failingWith(httpError(500), httpError(500), last, httpError(500));

    await expect(withRetry(operation.run, retryOptions())).rejects.toBe(last);
    expect(operation.calls()).toBe(3);
  });

  it.each([400, 401, 404, 409, 422])("does not retry HTTP %i", async (status) => {
    const operation = failingWith(httpError(status));
    const options = retryOptions();

    await expect(withRetry(operation.run, options)).rejects.toMatchObject({ status });
    expect(operation.calls()).toBe(1);
    expect(options.delays).toEqual([]);
  });

  it("does not retry a 403 that is a missing permission, not a rate limit", async () => {
    const operation = failingWith(httpError(403, {}, "Resource not accessible by integration"));

    await expect(withRetry(operation.run, retryOptions())).rejects.toMatchObject({ status: 403 });
    expect(operation.calls()).toBe(1);
  });

  it("waits as long as Retry-After asks before retrying a rate limit", async () => {
    const operation = failingWith(httpError(429, { "retry-after": "7" }));
    const options = retryOptions();

    await expect(withRetry(operation.run, options)).resolves.toBe("done");
    expect(options.delays).toEqual([7_000]);
  });

  it("waits until the quota resets after a primary rate limit", async () => {
    const resetInTwentySeconds = NOW / 1_000 + 20;
    const operation = failingWith(
      httpError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetInTwentySeconds }),
    );
    const options = retryOptions();

    await expect(withRetry(operation.run, options)).resolves.toBe("done");
    expect(options.delays).toEqual([21_000]);
  });

  it("waits a minute after a secondary rate limit that gives no time", async () => {
    const operation = failingWith(
      httpError(403, {}, "You have exceeded a secondary rate limit. Please wait."),
    );
    const options = retryOptions();

    await expect(withRetry(operation.run, options)).resolves.toBe("done");
    expect(options.delays).toEqual([60_000]);
  });

  it("fails at once when the rate limit would take longer than the allowed wait", async () => {
    const limited = httpError(429, { "retry-after": "3600" });
    const operation = failingWith(limited);
    const options = retryOptions();

    await expect(withRetry(operation.run, options)).rejects.toBe(limited);
    expect(operation.calls()).toBe(1);
    expect(options.delays).toEqual([]);
  });

  it("honours a shorter allowed wait", async () => {
    const operation = failingWith(httpError(429, { "retry-after": "7" }));

    await expect(
      withRetry(operation.run, retryOptions({ maxRateLimitDelayMs: 5_000 })),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("stops retrying a rate limit that never lifts", async () => {
    const limited = httpError(429, { "retry-after": "1" });
    const operation = failingWith(limited, limited, limited, limited);
    const options = retryOptions();

    await expect(withRetry(operation.run, options)).rejects.toBe(limited);
    expect(operation.calls()).toBe(3);
    expect(options.delays).toEqual([1_000, 1_000]);
  });

  it("waits with a real timer and the real clock when none are given", async () => {
    const operation = failingWith(httpError(500), httpError(429, { "retry-after": "0" }));

    await expect(
      withRetry(operation.run, { attempts: 3, baseDelayMs: 1, maxRateLimitDelayMs: 1_000 }),
    ).resolves.toBe("done");
  });
});

describe("isTransientHttpError", () => {
  it.each([500, 502, 503, 504])("treats HTTP %i as transient", (status) => {
    expect(isTransientHttpError(httpError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422, 429])("treats HTTP %i as not transient", (status) => {
    expect(isTransientHttpError(httpError(status))).toBe(false);
  });

  it("treats an error without a status, such as a network failure, as transient", () => {
    expect(isTransientHttpError(new TypeError("fetch failed"))).toBe(true);
  });

  it.each([null, undefined, "boom", 42])("treats the thrown value %j as not transient", (value) => {
    expect(isTransientHttpError(value)).toBe(false);
  });

  it("treats a status that is not a number as not transient", () => {
    expect(isTransientHttpError({ status: "500" })).toBe(false);
  });
});

describe("isRateLimitError", () => {
  it.each([
    ["a 429", httpError(429)],
    ["a 403 with Retry-After", httpError(403, { "retry-after": "30" })],
    ["a 403 with no quota left", httpError(403, { "x-ratelimit-remaining": "0" })],
    ["a 403 with a numeric Retry-After header", httpError(403, { "retry-after": 30 })],
    ["a 403 whose message names a rate limit", httpError(403, {}, "API rate limit exceeded")],
  ])("recognises %s", (_name, error) => {
    expect(isRateLimitError(error)).toBe(true);
  });

  it.each([
    ["a 403 for a missing permission", httpError(403, {}, "Resource not accessible")],
    ["a 403 with quota left", httpError(403, { "x-ratelimit-remaining": "4999" })],
    ["a 404", httpError(404)],
    ["a 500", httpError(500, { "retry-after": "5" })],
    ["a network failure", new TypeError("fetch failed")],
    ["a 403 without a response", Object.assign(new Error("Forbidden"), { status: 403 })],
    [
      "a 403 with unusable headers",
      Object.assign(new Error("x"), { status: 403, response: { headers: "none" } }),
    ],
    ["a string", "rate limit"],
    ["null", null],
  ])("does not mistake %s for a rate limit", (_name, error) => {
    expect(isRateLimitError(error)).toBe(false);
  });
});

describe("rateLimitDelayMs", () => {
  it("prefers Retry-After over the reset time", () => {
    const error = httpError(403, {
      "retry-after": "5",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": NOW / 1_000 + 500,
    });

    expect(rateLimitDelayMs(error, NOW)).toBe(5_000);
  });

  it("never returns a negative wait when the reset time has passed", () => {
    const error = httpError(403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": NOW / 1_000 - 30,
    });

    expect(rateLimitDelayMs(error, NOW)).toBe(1_000);
  });

  it.each([
    ["a Retry-After that is not a number", { "retry-after": "soon" }],
    ["a negative Retry-After", { "retry-after": "-5" }],
    [
      "a reset time that is not a number",
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "later" },
    ],
    [
      "a reset time while quota remains",
      { "x-ratelimit-remaining": "10", "x-ratelimit-reset": "1" },
    ],
    ["no headers", {}],
  ])("falls back to one minute for %s", (_name, headers) => {
    expect(rateLimitDelayMs(httpError(429, headers), NOW)).toBe(60_000);
  });
});
