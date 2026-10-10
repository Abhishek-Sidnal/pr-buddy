import type { ReviewRecord, ReviewStore } from "../../src/modules/reviews/review-store.js";

export interface RecordingReviewStore extends ReviewStore {
  readonly records: ReviewRecord[];
  /** When set, the next save rejects with it instead of recording. */
  failWith: Error | undefined;
}

/** A review store that keeps what it is given in an array, for tests to inspect. */
export function createRecordingReviewStore(): RecordingReviewStore {
  const store: RecordingReviewStore = {
    records: [],
    failWith: undefined,
    save(record) {
      if (store.failWith !== undefined) {
        return Promise.reject(store.failWith);
      }
      store.records.push(record);
      return Promise.resolve();
    },
  };
  return store;
}
