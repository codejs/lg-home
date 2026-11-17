/**
 * A throwaway SQLite file for this test file, opened and migrated on import.
 * (node --test runs every test file in its own process, so each file gets its
 * own database.) Import order doesn't matter: nothing opens a database on import.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dbModule from "../../src/server/db/index.js";

const dir = mkdtempSync(join(tmpdir(), "lg-home-unit-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

dbModule.openDatabase(join(dir, "test.db"));
dbModule.runMigrations();

export const { schema, runMigrations } = dbModule;
/** The test database (opened above). */
export const db = dbModule.db;

/** Empty every table (children first). */
export function resetDb(): void {
  db.delete(schema.sessions).run();
  db.delete(schema.subscriptions).run();
  db.delete(schema.deviceStates).run();
  db.delete(schema.events).run();
  db.delete(schema.devices).run();
  db.delete(schema.users).run();
  db.delete(schema.settings).run();
}
