import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Database } from "./database.js";

/** `apps/api/migrations`, two levels above this file in both the source and the compiled tree. */
export const MIGRATIONS_DIRECTORY = new URL("../../migrations/", import.meta.url);

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
/** An arbitrary constant that identifies PR Buddy's migration lock among advisory locks. */
const MIGRATION_LOCK_KEY = 7_233_190_521;

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** Reads the migration files of a directory in the order they must be applied. */
export function loadMigrations(directory: URL = MIGRATIONS_DIRECTORY): Migration[] {
  return readdirSync(directory)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(new URL(name, directory), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

/**
 * Brings the database schema up to date and returns the names of the migrations it applied.
 *
 * Everything happens in one transaction under an advisory lock: instances that start together
 * apply each migration once, and a failure leaves the database as it was.
 *
 * @throws {MigrationError} if a migration that was already applied has since been edited, or
 * the database has a migration this build does not know.
 */
export async function migrate(
  database: Database,
  migrations: readonly Migration[] = loadMigrations(),
): Promise<string[]> {
  return database.transaction(async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await transaction.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       text        PRIMARY KEY,
         checksum   text        NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const applied = await transaction.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const appliedChecksums = new Map(applied.rows.map((row) => [row.name, row.checksum]));
    const known = new Map(migrations.map((migration) => [migration.name, migration]));

    for (const [name, checksum] of appliedChecksums) {
      const migration = known.get(name);
      if (migration === undefined) {
        throw new MigrationError(
          `The database has migration ${name}, which this version does not include.`,
        );
      }
      if (migration.checksum !== checksum) {
        throw new MigrationError(
          `Migration ${name} was changed after it was applied. Add a new migration instead.`,
        );
      }
    }

    const newlyApplied: string[] = [];
    for (const migration of migrations) {
      if (appliedChecksums.has(migration.name)) {
        continue;
      }
      // Migration files are part of the application, not input: they are run as written.
      await transaction.query(migration.sql);
      await transaction.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
        migration.name,
        migration.checksum,
      ]);
      newlyApplied.push(migration.name);
    }
    return newlyApplied;
  });
}
