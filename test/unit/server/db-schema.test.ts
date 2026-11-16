import { db, resetDb, runMigrations, schema } from "../../helpers/test-db.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";

const now = new Date();
const addUser = (username: string) =>
  db.insert(schema.users).values({ username, passwordHash: "h", createdAt: now, updatedAt: now }).returning().get();
const addDevice = (id: string) =>
  db.insert(schema.devices).values({ id, type: "DEVICE_WASHER", alias: id, updatedAt: now }).run();

describe("database schema", () => {
  beforeEach(resetDb);

  it("migrations are idempotent", () => {
    assert.doesNotThrow(() => runMigrations());
    assert.doesNotThrow(() => runMigrations());
  });

  it("usernames are unique", () => {
    addUser("alice");
    assert.throws(() => addUser("alice"), /UNIQUE/);
  });

  it("a session must belong to an existing user (foreign keys are enforced)", () => {
    assert.throws(
      () => db.insert(schema.sessions).values({ id: "s", userId: 999, createdAt: now, expiresAt: now }).run(),
      /FOREIGN KEY/,
    );
  });

  it("deleting a user deletes their sessions", () => {
    const user = addUser("alice");
    db.insert(schema.sessions).values({ id: "s1", userId: user.id, createdAt: now, expiresAt: now }).run();
    db.delete(schema.users).where(eq(schema.users.id, user.id)).run();
    assert.equal(db.select().from(schema.sessions).all().length, 0);
  });

  it("status history must reference a known device and is deleted with it", () => {
    assert.throws(
      () => db.insert(schema.deviceStates).values({ deviceId: "ghost", state: {}, recordedAt: now }).run(),
      /FOREIGN KEY/,
    );
    addDevice("d1");
    db.insert(schema.deviceStates).values({ deviceId: "d1", state: { a: 1 }, recordedAt: now }).run();
    db.delete(schema.devices).where(eq(schema.devices.id, "d1")).run();
    assert.equal(db.select().from(schema.deviceStates).all().length, 0);
  });

  it("JSON columns round-trip nested data", () => {
    addDevice("d1");
    const state = { nested: { list: [1, "two", null, true], unicode: "ü🔐" } };
    db.insert(schema.deviceStates).values({ deviceId: "d1", state, recordedAt: now }).run();
    assert.deepEqual(db.select().from(schema.deviceStates).get()!.state, state);
  });

  it("timestamps round-trip with millisecond precision", () => {
    const at = new Date("2026-01-02T03:04:05.678Z");
    db.insert(schema.users).values({ username: "t", passwordHash: "h", createdAt: at, updatedAt: at }).run();
    assert.equal(db.select().from(schema.users).get()!.createdAt.toISOString(), at.toISOString());
  });
});
