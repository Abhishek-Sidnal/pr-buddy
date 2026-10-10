import { describe, expect, it } from "vitest";
import { isTransientHttpError, withRetry } from "../../src/api/retry.js";

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
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

function recordingSleep(): { sleep: (delayMs: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (delayMs) => {
      delays.push(delayMs);
      return Promise.resolve();
    },
  };
}

describe("withRetry", () => {
  it("returns the result of an operation that succeeds at once", async () => {
    const operation = failingWith();
    const { sleep, delays } = recordingSleep();

    await expect(
      withRetry(operation.run, isTransientHttpError, { attempts: 3, baseDelayMs: 100, sleep }),
    ).resolves.toBe("done");
    expect(operation.calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  it("tries again after transient failures, doubling the wait", async () => {
    const operation = failingWith(httpError(502), httpError(503));
    const { sleep, delays } = recordingSleep();

    await expect(
      withRetry(operation.run, isTransientHttpError, { attempts: 3, baseDelayMs: 100, sleep }),
    ).resolves.toBe("done");
    expect(operation.calls()).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("gives up after the configured number of attempts and rethrows the last error", async () => {
    const last = httpError(500);
    const operation = failingWith(httpError(500), httpError(500), last, httpError(500));
    const { sleep } = recordingSleep();

    await expect(
      withRetry(operation.run, isTransientHttpError, { attempts: 3, baseDelayMs: 1, sleep }),
    ).rejects.toBe(last);
    expect(operation.calls()).toBe(3);
  });

  it("does not retry a failure that is not transient", async () => {
    const operation = failingWith(httpError(404));
    const { sleep, delays } = recordingSleep();

    await expect(
      withRetry(operation.run, isTransientHttpError, { attempts: 3, baseDelayMs: 1, sleep }),
    ).rejects.toThrow("HTTP 404");
    expect(operation.calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  it("waits with a real timer when no sleep function is given", async () => {
    const operation = failingWith(httpError(500));

    await expect(
      withRetry(operation.run, isTransientHttpError, { attempts: 2, baseDelayMs: 1 }),
    ).resolves.toBe("done");
  });
});

describe("isTransientHttpError", () => {
  it.each([500, 502, 503, 504])("treats HTTP %i as transient", (status) => {
    expect(isTransientHttpError(httpError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422, 429])("treats HTTP %i as permanent", (status) => {
    expect(isTransientHttpError(httpError(status))).toBe(false);
  });

  it("treats an error without a status, such as a network failure, as transient", () => {
    expect(isTransientHttpError(new TypeError("fetch failed"))).toBe(true);
  });

  it.each([null, undefined, "boom", 42])("treats the thrown value %j as permanent", (value) => {
    expect(isTransientHttpError(value)).toBe(false);
  });

  it("treats a status that is not a number as permanent", () => {
    expect(isTransientHttpError({ status: "500" })).toBe(false);
  });
});
