/**
 * Point the app at a throwaway SQLite file, then load and migrate the DB.
 * Import this FIRST in any test that (transitively) imports src/server/db:
 * the DB module opens DATABASE_PATH when it is evaluated.
 * (node --test runs every test file in its own process, so each file gets its own DB.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "lg-home-unit-"));
process.env.DATABASE_PATH = join(dir, "test.db");
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const dbModule = await import("../../src/server/db/index.js");
dbModule.runMigrations();

export const { db, schema, runMigrations } = dbModule;

/** Empty every table (children first). */
export function resetDb(): void {
  db.delete(schema.sessions).run();
  db.delete(schema.deviceStates).run();
  db.delete(schema.events).run();
  db.delete(schema.devices).run();
  db.delete(schema.users).run();
  db.delete(schema.settings).run();
}
