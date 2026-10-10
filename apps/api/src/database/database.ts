import pg from "pg";

export type SqlValue = string | number | boolean | Date | null;

export interface QueryResult<Row> {
  readonly rows: Row[];
  readonly rowCount: number;
}

/** Runs parameterised statements. Values always travel separately from the SQL text. */
export interface Queryable {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly SqlValue[],
  ): Promise<QueryResult<Row>>;
}

export interface Database extends Queryable {
  /** Runs `work` in a transaction: committed if it resolves, rolled back if it rejects. */
  transaction<T>(work: (transaction: Queryable) => Promise<T>): Promise<T>;
  /** Closes every connection. The database cannot be used afterwards. */
  close(): Promise<void>;
}

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly poolSize: number;
  /**
   * Schema that unqualified table names resolve to. Tests use one per file; production leaves it
   * unset and uses the default.
   */
  readonly schema?: string;
  /** Called when an idle connection fails. Without a handler the process would crash. */
  readonly onConnectionError?: (error: Error) => void;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const CONNECTION_TIMEOUT_MS = 5_000;

function toQueryable(target: pg.Pool | pg.PoolClient): Queryable {
  return {
    // The type parameter is how a caller names the shape of the rows it selected.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    async query<Row>(text: string, values: readonly SqlValue[] = []) {
      const result = await target.query(text, [...values]);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    },
  };
}

/** Opens a connection pool to PostgreSQL. No connection is made until the first query. */
export function createDatabase(options: DatabaseOptions): Database {
  if (options.schema !== undefined && !SCHEMA_NAME.test(options.schema)) {
    // The schema name becomes part of a connection option, so it is never taken from input.
    throw new RangeError("Invalid schema name.");
  }

  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolSize,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    ...(options.schema === undefined ? {} : { options: `-c search_path=${options.schema}` }),
  });
  pool.on("error", (error) => {
    options.onConnectionError?.(error);
  });

  return {
    ...toQueryable(pool),

    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(toQueryable(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}

/** True when a trivial query succeeds. Never throws. */
export async function isReachable(database: Queryable): Promise<boolean> {
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
