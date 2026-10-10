export type ReviewJob = () => Promise<void>;

/**
 * - "queued": the job will run.
 * - "coalesced": a job for the same key was already waiting and now stands for both.
 * - "rejected": the queue is full; the caller should ask the sender to try again later.
 * - "rejected_for_group": the job's group already has as many jobs waiting as one group may.
 */
export type EnqueueResult = "queued" | "coalesced" | "rejected" | "rejected_for_group";

export interface ReviewQueue {
  /**
   * @param key   What must never run twice at once: a pull request.
   * @param group Who the job belongs to: an installation. Slots are shared fairly between
   *              groups, and one group may only have so many jobs waiting.
   */
  enqueue(key: string, group: string, job: ReviewJob): EnqueueResult;
  /** Resolves when nothing is running or waiting. */
  onIdle(): Promise<void>;
  /** Jobs waiting to start. */
  readonly waiting: number;
  /** Jobs running now. */
  readonly running: number;
}

export interface ReviewQueueOptions {
  /** Jobs that may run at the same time. */
  readonly concurrency: number;
  /** Jobs that may wait. */
  readonly maxWaiting: number;
  /** Jobs of one group that may wait. Defaults to `maxWaiting`: no limit of its own. */
  readonly maxWaitingPerGroup?: number;
  /** Called when a job rejects. The queue itself keeps going. */
  readonly onError: (error: unknown, key: string) => void;
}

interface KeyState {
  readonly group: string;
  isRunning: boolean;
  /** The job to run next for this key, if any. A newer job for the key replaces it. */
  waitingJob: ReviewJob | undefined;
}

interface GroupState {
  running: number;
  waiting: number;
  /** When a job of this group last started, as a count of starts; -1 if none has. */
  lastStarted: number;
}

/**
 * An in-process job queue keyed by pull request and shared fairly between installations.
 *
 * Jobs with the same key never overlap, so two reviews of one pull request cannot publish out of
 * order. At most one job per key waits: a job fetches the pull request's current state when it
 * starts, so a second waiting job for the same pull request would only repeat the first.
 *
 * A free slot goes to the group with the fewest jobs running, then to the group that was served
 * longest ago, then to the job that arrived first. A group with many jobs waiting therefore
 * delays itself and not the others (D-089).
 */
export function createReviewQueue(options: ReviewQueueOptions): ReviewQueue {
  const { concurrency, maxWaiting, onError } = options;
  const maxWaitingPerGroup = options.maxWaitingPerGroup ?? maxWaiting;
  const stateByKey = new Map<string, KeyState>();
  const stateByGroup = new Map<string, GroupState>();
  /** Keys that have a waiting job and no running job, in arrival order. */
  const readyKeys: string[] = [];
  let idleWaiters: (() => void)[] = [];
  let running = 0;
  let waiting = 0;
  let starts = 0;

  function groupOf(name: string): GroupState {
    let group = stateByGroup.get(name);
    if (group === undefined) {
      group = { running: 0, waiting: 0, lastStarted: -1 };
      stateByGroup.set(name, group);
    }
    return group;
  }

  function notifyIfIdle(): void {
    if (running === 0 && waiting === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  /** The position in `readyKeys` of the job that should start next, or -1 if none can. */
  function nextReadyIndex(): number {
    let best = -1;
    let bestGroup: GroupState | undefined;
    for (const [index, key] of readyKeys.entries()) {
      const state = stateByKey.get(key);
      if (state === undefined) {
        continue;
      }
      const group = groupOf(state.group);
      if (
        bestGroup === undefined ||
        group.running < bestGroup.running ||
        (group.running === bestGroup.running && group.lastStarted < bestGroup.lastStarted)
      ) {
        best = index;
        bestGroup = group;
      }
    }
    return best;
  }

  function finish(key: string, state: KeyState): void {
    const group = groupOf(state.group);
    running -= 1;
    group.running -= 1;
    state.isRunning = false;
    if (state.waitingJob === undefined) {
      stateByKey.delete(key);
    } else {
      readyKeys.push(key);
    }
    if (group.running === 0 && group.waiting === 0) {
      // Nothing of this group is left. An idle group is first in line when it comes back.
      stateByGroup.delete(state.group);
    }
    startReadyJobs();
    notifyIfIdle();
  }

  function startReadyJobs(): void {
    while (running < concurrency) {
      const index = nextReadyIndex();
      if (index === -1) {
        return;
      }
      const [key] = readyKeys.splice(index, 1);
      const state = key === undefined ? undefined : stateByKey.get(key);
      const job = state?.waitingJob;
      if (key === undefined || state === undefined || job === undefined) {
        return;
      }
      const group = groupOf(state.group);
      state.waitingJob = undefined;
      state.isRunning = true;
      waiting -= 1;
      running += 1;
      group.waiting -= 1;
      group.running += 1;
      group.lastStarted = starts;
      starts += 1;
      // The job is started through a promise so that a synchronous throw is handled too.
      void Promise.resolve()
        .then(job)
        .catch((error: unknown) => {
          onError(error, key);
        })
        .finally(() => {
          finish(key, state);
        });
    }
  }

  return {
    enqueue(key, groupName, job) {
      const state = stateByKey.get(key);
      if (state?.waitingJob !== undefined) {
        state.waitingJob = job;
        return "coalesced";
      }
      if (waiting >= maxWaiting) {
        return "rejected";
      }
      // A key keeps the group it was first seen with: a pull request does not change hands.
      const group = groupOf(state?.group ?? groupName);
      if (group.waiting >= maxWaitingPerGroup) {
        if (group.running === 0 && group.waiting === 0) {
          stateByGroup.delete(state?.group ?? groupName);
        }
        return "rejected_for_group";
      }
      waiting += 1;
      group.waiting += 1;
      if (state === undefined) {
        stateByKey.set(key, { group: groupName, isRunning: false, waitingJob: job });
        readyKeys.push(key);
        startReadyJobs();
      } else {
        // A job for this key is running; this one starts when it finishes.
        state.waitingJob = job;
      }
      return "queued";
    },

    onIdle() {
      if (running === 0 && waiting === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    get waiting() {
      return waiting;
    },

    get running() {
      return running;
    },
  };
}
