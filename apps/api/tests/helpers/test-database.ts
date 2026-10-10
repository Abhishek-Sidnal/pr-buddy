import { randomBytes } from "node:crypto";
import { createDatabase, type Database } from "../../src/database/database.js";

export interface TestDatabase {
  readonly database: Database;
  readonly schema: string;
  /** Drops the schema and closes the connections. */
  destroy(): Promise<void>;
}

function testDatabaseUrl(): string {
  const url = process.env["TEST_DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      "TEST_DATABASE_URL is not set. Storage tests need a real PostgreSQL: run the tests with " +
        "`docker compose run --rm dev npm test`, which provides one.",
    );
  }
  return url;
}

/**
 * Creates an empty schema in the test server and a database whose queries resolve to it. Every
 * test file gets its own, so files can run in parallel without seeing each other's rows.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const connectionString = testDatabaseUrl();
  const schema = `test_${randomBytes(8).toString("hex")}`;

  const admin = createDatabase({ connectionString, poolSize: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const database = createDatabase({ connectionString, poolSize: 5, schema });

  return {
    database,
    schema,
    async destroy() {
      await database.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    },
  };
}
