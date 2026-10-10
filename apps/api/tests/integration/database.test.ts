import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, isReachable } from "../../src/database/database.js";
import {
  loadMigrations,
  migrate,
  MigrationError,
  type Migration,
} from "../../src/database/migrate.js";
import { createTestDatabase, type TestDatabase } from "../helpers/test-database.js";

let test: TestDatabase;

beforeAll(async () => {
  test = await createTestDatabase();
});

afterAll(async () => {
  await test.destroy();
});

async function tableNames(): Promise<string[]> {
  const result = await test.database.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
    [test.schema],
  );
  return result.rows.map((row) => row.table_name);
}

function migration(name: string, sql: string, checksum = `checksum-of-${name}`): Migration {
  return { name, sql, checksum };
}

describe("database", () => {
  it("runs parameterised queries", async () => {
    const result = await test.database.query<{ sum: number; text: string }>(
      "SELECT $1::int + $2::int AS sum, $3::text AS text",
      [2, 3, "it's; DROP TABLE x --"],
    );

    expect(result.rows).toEqual([{ sum: 5, text: "it's; DROP TABLE x --" }]);
    expect(result.rowCount).toBe(1);
  });

  it("commits a transaction that succeeds", async () => {
    await test.database.query("CREATE TABLE committed (value int)");

    const returned = await test.database.transaction(async (transaction) => {
      await transaction.query("INSERT INTO committed VALUES ($1)", [1]);
      return "done";
    });

    expect(returned).toBe("done");
    expect((await test.database.query("SELECT * FROM committed")).rowCount).toBe(1);
  });

  it("rolls back a transaction that fails and rethrows the error", async () => {
    await test.database.query("CREATE TABLE rolled_back (value int)");
    const failure = new Error("stop");

    await expect(
      test.database.transaction(async (transaction) => {
        await transaction.query("INSERT INTO rolled_back VALUES ($1)", [1]);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect((await test.database.query("SELECT * FROM rolled_back")).rowCount).toBe(0);
  });

  it("reports that a working database is reachable", async () => {
    await expect(isReachable(test.database)).resolves.toBe(true);
  });

  it("reports that an unreachable database is not, without throwing", async () => {
    const errors: Error[] = [];
    const unreachable = createDatabase({
      connectionString: "postgres://nobody:nothing@127.0.0.1:1/nowhere",
      poolSize: 1,
      onConnectionError: (error) => errors.push(error),
    });

    await expect(isReachable(unreachable)).resolves.toBe(false);
    await unreachable.close();
  });

  it.each(["Robert'); DROP TABLE students;--", "has space", "UPPER", "", "a".repeat(64)])(
    "refuses the schema name %j",
    (schema) => {
      expect(() =>
        createDatabase({ connectionString: "postgres://localhost/x", poolSize: 1, schema }),
      ).toThrow(RangeError);
    },
  );
});

describe("migrate", () => {
  beforeEach(async () => {
    await test.database.query("DROP TABLE IF EXISTS schema_migrations, first, second CASCADE");
  });

  it("applies migrations in order and records them", async () => {
    const applied = await migrate(test.database, [
      migration("0001_first.sql", "CREATE TABLE first (id int)"),
      migration("0002_second.sql", "CREATE TABLE second (id int); INSERT INTO second VALUES (1);"),
    ]);

    expect(applied).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect(await tableNames()).toEqual(expect.arrayContaining(["first", "second"]));
    const recorded = await test.database.query(
      "SELECT name, checksum FROM schema_migrations ORDER BY name",
    );
    expect(recorded.rows).toEqual([
      { name: "0001_first.sql", checksum: "checksum-of-0001_first.sql" },
      { name: "0002_second.sql", checksum: "checksum-of-0002_second.sql" },
    ]);
  });

  it("applies nothing the second time", async () => {
    const migrations = [migration("0001_first.sql", "CREATE TABLE first (id int)")];
    await migrate(test.database, migrations);

    await expect(migrate(test.database, migrations)).resolves.toEqual([]);
  });

  it("applies only the migrations that are new", async () => {
    const first = migration("0001_first.sql", "CREATE TABLE first (id int)");
    await migrate(test.database, [first]);

    const applied = await migrate(test.database, [
      first,
      migration("0002_second.sql", "CREATE TABLE second (id int)"),
    ]);

    expect(applied).toEqual(["0002_second.sql"]);
  });

  it("leaves the database unchanged when a migration fails", async () => {
    const migrations = [
      migration("0001_first.sql", "CREATE TABLE first (id int)"),
      migration("0002_second.sql", "CREATE TABLE second (id int); THIS IS NOT SQL;"),
    ];

    await expect(migrate(test.database, migrations)).rejects.toThrow();

    expect(await tableNames()).not.toEqual(expect.arrayContaining(["first"]));
    expect(await tableNames()).not.toEqual(expect.arrayContaining(["schema_migrations"]));
  });

  it("refuses to start when an applied migration was edited", async () => {
    await migrate(test.database, [migration("0001_first.sql", "CREATE TABLE first (id int)")]);

    const edited = [migration("0001_first.sql", "CREATE TABLE first (id bigint)", "different")];

    await expect(migrate(test.database, edited)).rejects.toThrow(MigrationError);
    await expect(migrate(test.database, edited)).rejects.toThrow(
      "Migration 0001_first.sql was changed after it was applied.",
    );
  });

  it("refuses to start when the database is ahead of this version", async () => {
    await migrate(test.database, [
      migration("0001_first.sql", "CREATE TABLE first (id int)"),
      migration("0002_second.sql", "CREATE TABLE second (id int)"),
    ]);

    await expect(
      migrate(test.database, [migration("0001_first.sql", "CREATE TABLE first (id int)")]),
    ).rejects.toThrow("The database has migration 0002_second.sql");
  });

  it("applies each migration once when several instances start together", async () => {
    const migrations = [
      migration("0001_first.sql", "CREATE TABLE first (id int)"),
      migration("0002_second.sql", "CREATE TABLE second (id int)"),
    ];

    const results = await Promise.all([
      migrate(test.database, migrations),
      migrate(test.database, migrations),
      migrate(test.database, migrations),
    ]);

    expect(results.flat().sort()).toEqual(["0001_first.sql", "0002_second.sql"]);
  });
});

describe("the project's migrations", () => {
  it("are named in order and have distinct checksums", () => {
    const migrations = loadMigrations();

    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations.map((entry) => entry.name)).toEqual(
      migrations.map((entry) => entry.name).sort(),
    );
    expect(migrations[0]?.name).toBe("0001_initial.sql");
    expect(new Set(migrations.map((entry) => entry.checksum)).size).toBe(migrations.length);
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("create the schema from nothing, and are idempotent", async () => {
    const fresh = await createTestDatabase();
    try {
      const applied = await migrate(fresh.database);
      const again = await migrate(fresh.database);

      expect(applied).toEqual(loadMigrations().map((entry) => entry.name));
      expect(again).toEqual([]);
      const tables = await fresh.database.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
        [fresh.schema],
      );
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
        "ai_reviews",
        "findings",
        "pending_reviews",
        "repositories",
        "reviews",
        "rule_executions",
        "schema_migrations",
        "sessions",
        "webhook_deliveries",
      ]);
    } finally {
      await fresh.destroy();
    }
  });
});
