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
      queue.enqueue("pr-1", "group", () => {
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

    queue.enqueue("pr-a", "group", first.job);
    queue.enqueue("pr-b", "group", second.job);
    queue.enqueue("pr-c", "group", third.job);
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

    queue.enqueue("pr-1", "group", first.job);
    await settle();
    expect(queue.enqueue("pr-1", "group", second.job)).toBe("queued");
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

    queue.enqueue("pr-1", "group", running.job);
    await settle();
    expect(queue.enqueue("pr-1", "group", superseded.job)).toBe("queued");
    expect(queue.enqueue("pr-1", "group", newest.job)).toBe("coalesced");
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

    queue.enqueue("pr-a", "group", blocker.job);
    await settle();
    expect(queue.enqueue("pr-b", "group", superseded.job)).toBe("queued");
    expect(queue.enqueue("pr-b", "group", newest.job)).toBe("coalesced");

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

    queue.enqueue("pr-a", "group", blocker.job);
    await settle();
    expect(queue.enqueue("pr-b", "group", waiting.job)).toBe("queued");

    expect(queue.enqueue("pr-c", "group", () => Promise.resolve())).toBe("rejected");
    expect(queue.enqueue("pr-a", "group", () => Promise.resolve())).toBe("rejected");
    expect(queue.enqueue("pr-b", "group", waiting.job)).toBe("coalesced");

    blocker.finish();
    waiting.finish();
    await queue.onIdle();
    expect(queue.enqueue("pr-c", "group", () => Promise.resolve())).toBe("queued");
    await queue.onIdle();
  });

  it("reports a failed job and keeps running others", async () => {
    const { queue, errors } = createQueue({ concurrency: 1 });
    const failure = new Error("GitHub is down");
    let ranAfterFailure = false;

    queue.enqueue("pr-1", "group", () => Promise.reject(failure));
    queue.enqueue("pr-2", "group", () => {
      ranAfterFailure = true;
      return Promise.resolve();
    });
    await queue.onIdle();

    expect(errors).toEqual([{ error: failure, key: "pr-1" }]);
    expect(ranAfterFailure).toBe(true);
  });

  it("reports a job that throws before returning a promise", async () => {
    const { queue, errors } = createQueue();

    queue.enqueue("pr-1", "group", () => {
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
    queue.enqueue("pr-1", "group", only.job);

    const waiters = [queue.onIdle(), queue.onIdle()];
    only.finish();

    await expect(Promise.all(waiters)).resolves.toHaveLength(2);
  });
});

describe("sharing the queue between groups", () => {
  function fairQueue(options: { concurrency?: number; maxWaitingPerGroup?: number } = {}): {
    queue: ReviewQueue;
    log: string[];
    add: (key: string, group: string) => { finish: () => void; result: string };
  } {
    const log: string[] = [];
    const queue = createReviewQueue({
      concurrency: options.concurrency ?? 1,
      maxWaiting: 100,
      ...(options.maxWaitingPerGroup === undefined
        ? {}
        : { maxWaitingPerGroup: options.maxWaitingPerGroup }),
      onError: () => undefined,
    });
    return {
      queue,
      log,
      add(key, group) {
        const deferred = deferredJob(log, key);
        return { finish: deferred.finish, result: queue.enqueue(key, group, deferred.job) };
      },
    };
  }
  const started = (log: string[]): string[] =>
    log.filter((entry) => entry.startsWith("start ")).map((entry) => entry.slice(6));

  it("lets a group that just arrived go before another group's backlog", async () => {
    const { queue, log, add } = fairQueue();
    const jobs = [add("a1", "A"), add("a2", "A"), add("a3", "A"), add("b1", "B")];
    await settle();

    for (const job of jobs) {
      job.finish();
    }
    await queue.onIdle();

    // In arrival order b1 would be last. It is second: A has been served, B has not.
    expect(started(log)).toEqual(["a1", "b1", "a2", "a3"]);
  });

  it("takes turns between groups that both have a backlog", async () => {
    const { queue, log, add } = fairQueue();
    const jobs = [
      add("a1", "A"),
      add("a2", "A"),
      add("a3", "A"),
      add("b1", "B"),
      add("b2", "B"),
      add("c1", "C"),
    ];
    await settle();

    for (const job of jobs) {
      job.finish();
    }
    await queue.onIdle();

    expect(started(log)).toEqual(["a1", "b1", "c1", "a2", "b2", "a3"]);
  });

  it("gives a free slot to the group with the fewest jobs running", async () => {
    const { queue, log, add } = fairQueue({ concurrency: 2 });
    const a1 = add("a1", "A");
    const a2 = add("a2", "A");
    const a3 = add("a3", "A");
    const b1 = add("b1", "B");
    await settle();
    expect(started(log)).toEqual(["a1", "a2"]);

    // A still has one job running when the slot frees, B has none.
    a1.finish();
    await settle();

    expect(started(log)).toEqual(["a1", "a2", "b1"]);
    a2.finish();
    a3.finish();
    b1.finish();
    await queue.onIdle();
    expect(started(log)).toEqual(["a1", "a2", "b1", "a3"]);
  });

  it("keeps arrival order inside one group", async () => {
    const { queue, log, add } = fairQueue();
    const jobs = [add("a1", "A"), add("a2", "A"), add("a3", "A")];
    await settle();

    for (const job of jobs) {
      job.finish();
    }
    await queue.onIdle();

    expect(started(log)).toEqual(["a1", "a2", "a3"]);
  });

  it("caps how many jobs of one group may wait, and leaves other groups alone", async () => {
    const { queue, add } = fairQueue({ maxWaitingPerGroup: 2 });
    add("a1", "A");
    await settle();

    expect(add("a2", "A").result).toBe("queued");
    expect(add("a3", "A").result).toBe("queued");
    expect(add("a4", "A").result).toBe("rejected_for_group");
    expect(add("b1", "B").result).toBe("queued");
    expect(queue.waiting).toBe(3);
    // A job that replaces a waiting one is not one more job.
    expect(add("a3", "A").result).toBe("coalesced");
  });

  it("has room for a group again as soon as one of its jobs starts", async () => {
    const { add } = fairQueue({ maxWaitingPerGroup: 1 });
    const first = add("a1", "A");
    await settle();
    expect(add("a2", "A").result).toBe("queued");
    expect(add("a3", "A").result).toBe("rejected_for_group");

    first.finish();
    await settle();

    expect(add("a3", "A").result).toBe("queued");
  });

  it("counts a job waiting behind its own key against its group", async () => {
    const { add } = fairQueue({ maxWaitingPerGroup: 1 });
    add("a1", "A");
    await settle();

    // a1 is running; this is a second job for the same key, which waits.
    expect(add("a1", "A").result).toBe("queued");
    expect(add("a2", "A").result).toBe("rejected_for_group");
  });

  it("does not remember a group whose only job was refused", () => {
    const { queue, add } = fairQueue({ maxWaitingPerGroup: 0 });

    expect(add("a1", "A").result).toBe("rejected_for_group");
    expect(queue.waiting).toBe(0);
    expect(queue.running).toBe(0);
  });

  it("applies the overall limit before the group's", async () => {
    const queue = createReviewQueue({
      concurrency: 1,
      maxWaiting: 1,
      maxWaitingPerGroup: 5,
      onError: () => undefined,
    });
    const held = deferredJob([], "held");
    queue.enqueue("a1", "A", held.job);
    await settle();
    queue.enqueue("a2", "A", () => Promise.resolve());

    expect(queue.enqueue("b1", "B", () => Promise.resolve())).toBe("rejected");
    held.finish();
    await queue.onIdle();
  });

  it("serves a group first when it returns after being idle", async () => {
    const { queue, log, add } = fairQueue();
    add("b1", "B").finish();
    await queue.onIdle();

    const jobs = [add("a1", "A"), add("a2", "A"), add("b2", "B")];
    await settle();
    for (const job of jobs) {
      job.finish();
    }
    await queue.onIdle();

    expect(started(log)).toEqual(["b1", "a1", "b2", "a2"]);
  });

  it("stays fair after a job fails", async () => {
    const log: string[] = [];
    const errors: string[] = [];
    const queue = createReviewQueue({
      concurrency: 1,
      maxWaiting: 10,
      onError: (_error, key) => errors.push(key),
    });
    const track = (name: string) => (): Promise<void> => {
      log.push(name);
      return Promise.resolve();
    };

    queue.enqueue("a1", "A", () => Promise.reject(new Error("failed")));
    queue.enqueue("a2", "A", track("a2"));
    queue.enqueue("b1", "B", track("b1"));
    await queue.onIdle();

    expect(errors).toEqual(["a1"]);
    expect(log).toEqual(["b1", "a2"]);
    expect(queue.running).toBe(0);
    expect(queue.waiting).toBe(0);
  });
});
