/**
 * Remembers which webhook deliveries have been accepted, so that a delivery GitHub sends twice
 * is processed once. Asynchronous so that a database can implement it later.
 */
export interface DeliveryStore {
  /** Records the delivery. Resolves to false if it was already recorded. */
  claim(deliveryId: string): Promise<boolean>;
  /** Forgets a delivery that could not be processed, so that it can be sent again. */
  release(deliveryId: string): Promise<void>;
}

export interface InMemoryDeliveryStoreOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  /** Replaceable so tests control time. */
  readonly now?: () => number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * A delivery store held in process memory. It forgets entries after `ttlMs`, never holds more
 * than `maxEntries`, and is emptied by a restart.
 */
export function createInMemoryDeliveryStore(
  options: InMemoryDeliveryStoreOptions = {},
): DeliveryStore {
  const ttlMs = options.ttlMs ?? ONE_DAY_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  /** Delivery ID to expiry time. A Map iterates in insertion order, which is also expiry order. */
  const expiryById = new Map<string, number>();

  function removeExpired(currentTime: number): void {
    for (const [deliveryId, expiresAt] of expiryById) {
      if (expiresAt > currentTime) {
        break;
      }
      expiryById.delete(deliveryId);
    }
  }

  return {
    claim(deliveryId) {
      const currentTime = now();
      removeExpired(currentTime);
      if (expiryById.has(deliveryId)) {
        return Promise.resolve(false);
      }
      expiryById.set(deliveryId, currentTime + ttlMs);
      if (expiryById.size > maxEntries) {
        const oldest = expiryById.keys().next();
        if (oldest.done !== true) {
          expiryById.delete(oldest.value);
        }
      }
      return Promise.resolve(true);
    },

    release(deliveryId) {
      expiryById.delete(deliveryId);
      return Promise.resolve();
    },
  };
}
