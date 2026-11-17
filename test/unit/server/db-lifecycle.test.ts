/**
 * The database is opened explicitly (server startup, add_user, tests), never
 * as a side effect of importing a module. This file deliberately doesn't use
 * test-db.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "lg-home-db-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// If importing opened the database, it would create this file.
const trap = join(dir, "must-not-exist", "app.db");
process.env.DATABASE_PATH = trap;

const dbModule = await import("../../../src/server/db/index.js");
await import("../../../src/server/app.js");
await import("../../../src/server/users.js");
const devices = await import("../../../src/server/devices/store.js");
const events = await import("../../../src/server/events/store.js");

describe("database lifecycle", () => {
  it("importing the server's modules opens nothing and creates no file", () => {
    assert.equal(dbModule.isDatabaseOpen(), false);
    assert.equal(existsSync(trap), false);
  });

  it("using the database before opening it fails with a clear error", () => {
    assert.throws(() => devices.listDevices(), /The database is not open: call openDatabase\(\) first/);
    assert.throws(() => events.queryEvents({ limit: 1 }), /not open/);
  });

  it("openDatabase creates the file (and missing folders); stores then work", () => {
    const path = join(dir, "nested", "folders", "a.db");
    dbModule.openDatabase(path);
    dbModule.runMigrations();
    assert.equal(dbModule.isDatabaseOpen(), true);
    assert.ok(existsSync(path));
    assert.deepEqual(devices.listDevices(), []);
    devices.saveDevices([{ deviceId: "d1", deviceInfo: { deviceType: "DEVICE_WASHER", alias: "Washer" } }]);
    assert.deepEqual(devices.listDevices().map((d) => d.id), ["d1"]);
  });

  it("closeDatabase closes it; reopening another file switches over", () => {
    dbModule.closeDatabase();
    assert.equal(dbModule.isDatabaseOpen(), false);
    assert.throws(() => devices.listDevices(), /not open/);

    dbModule.openDatabase(":memory:");
    dbModule.runMigrations();
    assert.deepEqual(devices.listDevices(), [], "a different, empty database");
    dbModule.closeDatabase();
  });

  it("DATABASE_PATH alone never opened anything", () => {
    assert.equal(existsSync(trap), false);
  });
});
