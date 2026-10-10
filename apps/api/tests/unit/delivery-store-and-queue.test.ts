import { describe, expect, it } from "vitest";
import { createInMemoryDeliveryStore } from "../../src/modules/github/delivery-store.js";
import { createReviewQueue, type ReviewQueue } from "../../src/modules/reviews/review-queue.js";

describe("in-memory delivery store", () => {
  it("accepts a delivery once", async () => {
    const store = createInMemoryDeliveryStore();

    await expect(store.claim("delivery-1")).resolves.toBe(true);
    await expect(store.claim("delivery-1")).resolves.toBe(false);
    await expect(store.claim("delivery-2")).resolves.toBe(true);
  });

  it("accepts a released delivery again", async () => {
    const store = createInMemoryDeliveryStore();
    await store.claim("delivery-1");

    await store.release("delivery-1");

    await expect(store.claim("delivery-1")).resolves.toBe(true);
  });

  it("releasing an unknown delivery does nothing", async () => {
    await expect(createInMemoryDeliveryStore().release("never-seen")).resolves.toBeUndefined();
  });

  it("forgets a delivery after its time to live", async () => {
    let time = 1_000;
    const store = createInMemoryDeliveryStore({ ttlMs: 100, now: () => time });
    await store.claim("delivery-1");

    time += 99;
    await expect(store.claim("delivery-1")).resolves.toBe(false);

    time += 1;
    await expect(store.claim("delivery-1")).resolves.toBe(true);
  });

  it("never holds more than the maximum number of entries", async () => {
    const store = createInMemoryDeliveryStore({ maxEntries: 2 });
    await store.claim("delivery-1");
    await store.claim("delivery-2");

    await store.claim("delivery-3");

    // The oldest was evicted to make room, so it is accepted again; the newer ones are remembered.
    await expect(store.claim("delivery-3")).resolves.toBe(false);
    await expect(store.claim("delivery-2")).resolves.toBe(false);
    await expect(store.claim("delivery-1")).resolves.toBe(true);
  });
});

/** A job whose completion the test controls. */
function deferredJob(
  log: string[],
  name: string,
): { job: () => Promise<void>; finish: () => void } {
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    finish,
    job: async () => {
      log.push(`start ${name}`);
      await done;
      log.push(`end ${name}`);
    },
  };
}

/** Lets promise callbacks that are already scheduled run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function createQueue(overrides: { concurrency?: number; maxWaiting?: number } = {}): {
  queue: ReviewQueue;
  errors: { error: unknown; key: string }[];
} {
  const errors: { error: unknown; key: string }[] = [];
  const queue = createReviewQueue({
    concurrency: overrides.concurrency ?? 2,
    maxWaiting: overrides.maxWaiting ?? 10,
    onError: (error, key) => errors.push({ error, key }),
  });
  return { queue, errors };
}

describe("review queue", () => {
  it("runs a job and becomes idle", async () => {
    const { queue } = createQueue();
    let ran = false;

    expect(
      queue.enqueue("pr-1", () => {
        ran = true;
        return Promise.resolve();
      }),
    ).toBe("queued");
    await queue.onIdle();

    expect(ran).toBe(true);
    expect(queue.running).toBe(0);
    expect(queue.waiting).toBe(0);
  });

  it("is idle at once when nothing was queued", async () => {
    await expect(createQueue().queue.onIdle()).resolves.toBeUndefined();
  });

  it("runs jobs for different keys at the same time, up to the concurrency limit", async () => {
    const { queue } = createQueue({ concurrency: 2 });
    const log: string[] = [];
    const first = deferredJob(log, "a");
    const second = deferredJob(log, "b");
    const third = deferredJob(log, "c");

    queue.enqueue("pr-a", first.job);
    queue.enqueue("pr-b", second.job);
    queue.enqueue("pr-c", third.job);
    await settle();

    expect(log).toEqual(["start a", "start b"]);
    expect(queue.running).toBe(2);
    expect(queue.waiting).toBe(1);

    first.finish();
    await settle();
    expect(log).toEqual(["start a", "start b", "end a", "start c"]);

    second.finish();
    third.finish();
    await queue.onIdle();
    expect(log).toHaveLength(6);
  });

  it("never runs two jobs for the same key at once", async () => {
    const { queue } = createQueue({ concurrency: 5 });
    const log: string[] = [];
    const first = deferredJob(log, "first");
    const second = deferredJob(log, "second");

    queue.enqueue("pr-1", first.job);
    await settle();
    expect(queue.enqueue("pr-1", second.job)).toBe("queued");
    await settle();

    expect(log).toEqual(["start first"]);

    first.finish();
    await settle();
    expect(log).toEqual(["start first", "end first", "start second"]);

    second.finish();
    await queue.onIdle();
  });

  it("keeps only the newest waiting job for a key", async () => {
    const { queue } = createQueue();
    const log: string[] = [];
    const running = deferredJob(log, "running");
    const superseded = deferredJob(log, "superseded");
    const newest = deferredJob(log, "newest");

    queue.enqueue("pr-1", running.job);
    await settle();
    expect(queue.enqueue("pr-1", superseded.job)).toBe("queued");
    expect(queue.enqueue("pr-1", newest.job)).toBe("coalesced");
    expect(queue.waiting).toBe(1);

    running.finish();
    newest.finish();
    await queue.onIdle();

    expect(log).toEqual(["start running", "end running", "start newest", "end newest"]);
  });

  it("coalesces jobs that are waiting for a free slot", async () => {
    const { queue } = createQueue({ concurrency: 1 });
    const log: string[] = [];
    const blocker = deferredJob(log, "blocker");
    const superseded = deferredJob(log, "superseded");
    const newest = deferredJob(log, "newest");

    queue.enqueue("pr-a", blocker.job);
    await settle();
    expect(queue.enqueue("pr-b", superseded.job)).toBe("queued");
    expect(queue.enqueue("pr-b", newest.job)).toBe("coalesced");

    blocker.finish();
    newest.finish();
    await queue.onIdle();

    expect(log).toEqual(["start blocker", "end blocker", "start newest", "end newest"]);
  });

  it("rejects new work when the waiting list is full, but still coalesces", async () => {
    const { queue } = createQueue({ concurrency: 1, maxWaiting: 1 });
    const log: string[] = [];
    const blocker = deferredJob(log, "blocker");
    const waiting = deferredJob(log, "waiting");

    queue.enqueue("pr-a", blocker.job);
    await settle();
    expect(queue.enqueue("pr-b", waiting.job)).toBe("queued");

    expect(queue.enqueue("pr-c", () => Promise.resolve())).toBe("rejected");
    expect(queue.enqueue("pr-a", () => Promise.resolve())).toBe("rejected");
    expect(queue.enqueue("pr-b", waiting.job)).toBe("coalesced");

    blocker.finish();
    waiting.finish();
    await queue.onIdle();
    expect(queue.enqueue("pr-c", () => Promise.resolve())).toBe("queued");
    await queue.onIdle();
  });

  it("reports a failed job and keeps running others", async () => {
    const { queue, errors } = createQueue({ concurrency: 1 });
    const failure = new Error("GitHub is down");
    let ranAfterFailure = false;

    queue.enqueue("pr-1", () => Promise.reject(failure));
    queue.enqueue("pr-2", () => {
      ranAfterFailure = true;
      return Promise.resolve();
    });
    await queue.onIdle();

    expect(errors).toEqual([{ error: failure, key: "pr-1" }]);
    expect(ranAfterFailure).toBe(true);
  });

  it("reports a job that throws before returning a promise", async () => {
    const { queue, errors } = createQueue();

    queue.enqueue("pr-1", () => {
      throw new Error("thrown synchronously");
    });
    await queue.onIdle();

    expect(errors).toHaveLength(1);
    expect(queue.running).toBe(0);
  });

  it("wakes every caller waiting for idle", async () => {
    const { queue } = createQueue();
    const log: string[] = [];
    const only = deferredJob(log, "only");
    queue.enqueue("pr-1", only.job);

    const waiters = [queue.onIdle(), queue.onIdle()];
    only.finish();

    await expect(Promise.all(waiters)).resolves.toHaveLength(2);
  });
});
