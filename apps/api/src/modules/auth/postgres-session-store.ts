import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../../database/database.js";
import { SESSION_TTL_SECONDS, type SessionStore } from "./session-store.js";

export interface PostgresSessionStoreOptions {
  /** How long a session lasts. */
  readonly ttlSeconds?: number;
  /** Expired rows are deleted once in this many sign-ins. */
  readonly purgeEvery?: number;
}

const TOKEN_BYTES = 32;
/** A token as this store issues it. Anything else cannot be a session and is not looked up. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_PURGE_EVERY = 50;

interface SessionRow {
  readonly user_id: string;
  readonly login: string;
  readonly installation_ids: readonly string[];
  readonly expires_at: Date;
}

/** The token is random, so a plain hash is enough: there is nothing to guess. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A PostgreSQL array literal for whole numbers. The values are numbers already, so the text
 * holds digits and commas only; it still travels as a parameter, never as part of the SQL.
 */
export function toBigintArrayLiteral(values: readonly number[]): string {
  return `{${values.filter((value) => Number.isSafeInteger(value)).join(",")}}`;
}

/** A session store backed by the `sessions` table. Only the hash of each token is written. */
export function createPostgresSessionStore(
  database: Queryable,
  options: PostgresSessionStoreOptions = {},
): SessionStore {
  const ttlSeconds = options.ttlSeconds ?? SESSION_TTL_SECONDS;
  const purgeEvery = options.purgeEvery ?? DEFAULT_PURGE_EVERY;
  let createdSincePurge = 0;

  return {
    async create(session) {
      createdSincePurge += 1;
      if (createdSincePurge >= purgeEvery) {
        createdSincePurge = 0;
        await database.query("DELETE FROM sessions WHERE expires_at <= now()");
      }

      const token = randomBytes(TOKEN_BYTES).toString("base64url");
      await database.query(
        `INSERT INTO sessions (token_hash, user_id, login, installation_ids, expires_at)
         VALUES ($1, $2, $3, $4::bigint[], now() + make_interval(secs => $5))`,
        [
          hashToken(token),
          session.userId,
          session.login,
          toBigintArrayLiteral(session.installationIds),
          ttlSeconds,
        ],
      );
      return token;
    },

    async find(token) {
      if (!TOKEN_FORMAT.test(token)) {
        return undefined;
      }
      const result = await database.query<SessionRow>(
        `SELECT user_id, login, installation_ids, expires_at
         FROM sessions
         WHERE token_hash = $1 AND expires_at > now()`,
        [hashToken(token)],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return undefined;
      }
      return {
        // PostgreSQL returns bigint as text; GitHub's IDs fit in a JavaScript number.
        userId: Number(row.user_id),
        login: row.login,
        installationIds: row.installation_ids.map(Number),
        expiresAt: row.expires_at,
      };
    },

    async delete(token) {
      if (TOKEN_FORMAT.test(token)) {
        await database.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
      }
    },
  };
}
