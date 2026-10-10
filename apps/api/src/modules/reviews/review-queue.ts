export type ReviewJob = () => Promise<void>;

/**
 * - "queued": the job will run.
 * - "coalesced": a job for the same key was already waiting and now stands for both.
 * - "rejected": the queue is full; the caller should ask the sender to try again later.
 */
export type EnqueueResult = "queued" | "coalesced" | "rejected";

export interface ReviewQueue {
  enqueue(key: string, job: ReviewJob): EnqueueResult;
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
  /** Called when a job rejects. The queue itself keeps going. */
  readonly onError: (error: unknown, key: string) => void;
}

interface KeyState {
  isRunning: boolean;
  /** The job to run next for this key, if any. A newer job for the key replaces it. */
  waitingJob: ReviewJob | undefined;
}

/**
 * An in-process job queue keyed by pull request.
 *
 * Jobs with the same key never overlap, so two reviews of one pull request cannot publish out of
 * order. At most one job per key waits: a job fetches the pull request's current state when it
 * starts, so a second waiting job for the same pull request would only repeat the first.
 */
export function createReviewQueue(options: ReviewQueueOptions): ReviewQueue {
  const { concurrency, maxWaiting, onError } = options;
  const stateByKey = new Map<string, KeyState>();
  /** Keys that have a waiting job and no running job, in arrival order. */
  const readyKeys: string[] = [];
  let idleWaiters: (() => void)[] = [];
  let running = 0;
  let waiting = 0;

  function notifyIfIdle(): void {
    if (running === 0 && waiting === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  function finish(key: string, state: KeyState): void {
    running -= 1;
    state.isRunning = false;
    if (state.waitingJob === undefined) {
      stateByKey.delete(key);
    } else {
      readyKeys.push(key);
    }
    startReadyJobs();
    notifyIfIdle();
  }

  function startReadyJobs(): void {
    while (running < concurrency) {
      const key = readyKeys.shift();
      const state = key === undefined ? undefined : stateByKey.get(key);
      const job = state?.waitingJob;
      if (key === undefined || state === undefined || job === undefined) {
        return;
      }
      state.waitingJob = undefined;
      state.isRunning = true;
      waiting -= 1;
      running += 1;
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
    enqueue(key, job) {
      const state = stateByKey.get(key);
      if (state?.waitingJob !== undefined) {
        state.waitingJob = job;
        return "coalesced";
      }
      if (waiting >= maxWaiting) {
        return "rejected";
      }
      waiting += 1;
      if (state === undefined) {
        stateByKey.set(key, { isRunning: false, waitingJob: job });
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
