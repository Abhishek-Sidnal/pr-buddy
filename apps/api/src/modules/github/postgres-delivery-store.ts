import type { Queryable } from "../../database/database.js";
import type { DeliveryStore } from "./delivery-store.js";

export interface PostgresDeliveryStoreOptions {
  /** How long a delivery is remembered. */
  readonly ttlSeconds?: number;
  /** Expired rows are deleted once in this many claims. */
  readonly purgeEvery?: number;
}

const ONE_DAY_SECONDS = 24 * 60 * 60;
const DEFAULT_PURGE_EVERY = 500;

/**
 * A delivery store backed by the `webhook_deliveries` table. It survives restarts and is shared
 * by every instance of the service.
 */
export function createPostgresDeliveryStore(
  database: Queryable,
  options: PostgresDeliveryStoreOptions = {},
): DeliveryStore {
  const ttlSeconds = options.ttlSeconds ?? ONE_DAY_SECONDS;
  const purgeEvery = options.purgeEvery ?? DEFAULT_PURGE_EVERY;
  let claimsSincePurge = 0;

  return {
    async claim(deliveryId) {
      claimsSincePurge += 1;
      if (claimsSincePurge >= purgeEvery) {
        claimsSincePurge = 0;
        await database.query(
          "DELETE FROM webhook_deliveries WHERE received_at <= now() - make_interval(secs => $1)",
          [ttlSeconds],
        );
      }

      // One atomic statement: insert the delivery, or take over a row that has expired. A row
      // comes back only for the caller that won, so two instances cannot both accept a delivery.
      const result = await database.query(
        `INSERT INTO webhook_deliveries (delivery_id)
         VALUES ($1)
         ON CONFLICT (delivery_id) DO UPDATE
           SET received_at = now()
           WHERE webhook_deliveries.received_at <= now() - make_interval(secs => $2)
         RETURNING delivery_id`,
        [deliveryId, ttlSeconds],
      );
      return result.rowCount === 1;
    },

    async release(deliveryId) {
      await database.query("DELETE FROM webhook_deliveries WHERE delivery_id = $1", [deliveryId]);
    },
  };
}
