import { db, resetDb, schema } from "../../helpers/test-db.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FastifyInstance, InjectOptions } from "fastify";
import { ThinQError } from "../../../src/server/thinq/client.js";
import { buildTestApp, createUser, login, as } from "../../helpers/app.js";
import type { StubThinQ } from "../../helpers/stub-thinq.js";

const device = (id: string, info: Record<string, unknown> = {}) => ({
  deviceId: id,
  deviceInfo: { deviceType: "DEVICE_WASHER", alias: `Alias ${id}`, modelName: `M-${id}`, reportable: true, ...info },
});

describe("device routes", () => {
  let app: FastifyInstance;
  let thinq: StubThinQ;
  let cookie: string;
  const call = (options: InjectOptions) => as(app, cookie, options);
  const sync = () => call({ method: "POST", url: "/api/devices/sync" });

  beforeEach(async () => {
    resetDb();
    await createUser();
    ({ app, thinq } = await buildTestApp());
    cookie = await login(app);
  });
  afterEach(() => app.close());

  describe("GET /api/devices", () => {
    it("is empty before the first sync and does not call ThinQ", async () => {
      const res = await call({ method: "GET", url: "/api/devices" });
      assert.deepEqual(res.json(), []);
      assert.equal(thinq.calls.length, 0);
    });

    it("lists stored devices sorted by alias", async () => {
      thinq.devices = [device("1", { alias: "Zeta" }), device("2", { alias: "Alpha" }), device("3", { alias: "Mid" })];
      await sync();
      const res = await call({ method: "GET", url: "/api/devices" });
      assert.deepEqual(res.json().map((d: { alias: string }) => d.alias), ["Alpha", "Mid", "Zeta"]);
    });
  });

  describe("POST /api/devices/sync", () => {
    it("stores the ThinQ device list", async () => {
      thinq.devices = [device("d1")];
      const res = await sync();
      assert.equal(res.statusCode, 200);
      const [d] = res.json();
      assert.equal(d.id, "d1");
      assert.equal(d.type, "DEVICE_WASHER");
      assert.equal(d.alias, "Alias d1");
      assert.equal(d.modelName, "M-d1");
      assert.equal(d.reportable, true);
      assert.deepEqual(d.raw, device("d1"), "raw ThinQ entry kept for debugging");
      assert.ok(!Number.isNaN(Date.parse(d.updatedAt)));
    });

    it("updates existing devices instead of duplicating them", async () => {
      thinq.devices = [device("d1", { alias: "Old name" })];
      await sync();
      thinq.devices = [device("d1", { alias: "New name", reportable: false })];
      const res = await sync();
      assert.equal(res.json().length, 1);
      assert.equal(res.json()[0].alias, "New name");
      assert.equal(res.json()[0].reportable, false);
    });

    it("keeps status history when a device is re-synced", async () => {
      thinq.devices = [device("d1")];
      await sync();
      await call({ method: "GET", url: "/api/devices/d1/status" });
      await sync();
      assert.equal(db.select().from(schema.deviceStates).all().length, 1);
    });

    it("falls back alias -> model name -> device id", async () => {
      thinq.devices = [
        device("a", { alias: undefined }),
        device("b", { alias: undefined, modelName: undefined }),
        device("c", { alias: "" }),
      ];
      const byId = Object.fromEntries((await sync()).json().map((d: { id: string; alias: string }) => [d.id, d.alias]));
      assert.deepEqual(byId, { a: "M-a", b: "b", c: "M-c" });
    });

    it("stores missing optional fields as null", async () => {
      thinq.devices = [{ deviceId: "bare", deviceInfo: { deviceType: "DEVICE_OVEN" } }];
      const [d] = (await sync()).json();
      assert.equal(d.modelName, null);
      assert.equal(d.reportable, null);
    });

    it("ignores wrongly-typed optional fields from ThinQ", async () => {
      thinq.devices = [device("d1", { reportable: "yes", alias: 42, modelName: { x: 1 } })];
      const [d] = (await sync()).json();
      assert.equal(d.reportable, null);
      assert.equal(d.alias, "d1");
      assert.equal(d.modelName, null);
    });

    // Regression: one bad entry used to abort the whole sync with a 500.
    it("skips malformed entries and keeps the good ones", async () => {
      thinq.devices = [
        device("good"),
        null,
        "nonsense",
        { deviceId: "no-info" },
        { deviceId: "", deviceInfo: { deviceType: "X" } },
        { deviceId: 42, deviceInfo: { deviceType: "X" } },
        { deviceId: "no-type", deviceInfo: {} },
        { deviceId: "null-info", deviceInfo: null },
      ];
      const res = await sync();
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().map((d: { id: string }) => d.id), ["good"]);
    });

    it("treats a non-array response as an empty list", async () => {
      thinq.devices = { unexpected: "shape" };
      const res = await sync();
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), []);
    });

    it("stores hostile strings verbatim (the SPA renders them as text)", async () => {
      const alias = `<img src=x onerror=alert(1)>'; DROP TABLE devices; --`;
      thinq.devices = [device("d1", { alias })];
      assert.equal((await sync()).json()[0].alias, alias);
      assert.equal((await call({ method: "GET", url: "/api/devices" })).json()[0].alias, alias);
    });

    it("leaves the database untouched when ThinQ fails", async () => {
      thinq.devices = [device("d1")];
      await sync();
      thinq.error = new ThinQError("boom", "response", 500, "0000");
      const res = await sync();
      assert.equal(res.statusCode, 502);
      assert.equal(db.select().from(schema.devices).all().length, 1);
    });

    it("keeps devices that ThinQ no longer lists (documented current behaviour)", async () => {
      thinq.devices = [device("d1"), device("d2")];
      await sync();
      thinq.devices = [device("d1")];
      assert.deepEqual((await sync()).json().map((d: { id: string }) => d.id).sort(), ["d1", "d2"]);
    });
  });

  describe("GET /api/devices/:id/status", () => {
    beforeEach(async () => {
      thinq.devices = [device("d1"), device("d2")];
      await sync();
      thinq.calls.length = 0;
    });

    it("returns live state and records a snapshot", async () => {
      thinq.status = { power: "ON", nested: { temp: 3 } };
      const res = await call({ method: "GET", url: "/api/devices/d1/status" });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { power: "ON", nested: { temp: 3 } });
      assert.deepEqual(thinq.calls, [{ method: "getDeviceStatus", args: ["d1"] }]);
      const rows = db.select().from(schema.deviceStates).all();
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].state, { power: "ON", nested: { temp: 3 } });
    });

    it("404s for devices that were never synced, without calling ThinQ", async () => {
      const res = await call({ method: "GET", url: "/api/devices/unknown/status" });
      assert.equal(res.statusCode, 404);
      assert.match(res.json().error, /sync/);
      assert.equal(thinq.calls.length, 0);
    });

    it("does not record a snapshot when ThinQ fails", async () => {
      thinq.error = new ThinQError("not connected", "response", 400, "1222");
      const res = await call({ method: "GET", url: "/api/devices/d1/status" });
      assert.equal(res.statusCode, 502);
      assert.equal(db.select().from(schema.deviceStates).all().length, 0);
    });

    it("looks ids up exactly (no wildcard or injection matching)", async () => {
      for (const id of ["d%25", "d_", "d1' OR '1'='1", "D1"]) {
        const res = await call({ method: "GET", url: `/api/devices/${encodeURIComponent(id)}/status` });
        assert.equal(res.statusCode, 404, id);
      }
      assert.equal(thinq.calls.length, 0);
    });
  });

  describe("GET /api/devices/:id/history", () => {
    async function record(id: string, n: number) {
      for (let i = 0; i < n; i++) {
        thinq.status = { seq: i };
        await call({ method: "GET", url: `/api/devices/${id}/status` });
      }
    }

    beforeEach(async () => {
      thinq.devices = [device("d1"), device("d2")];
      await sync();
    });

    it("returns snapshots newest first, only for that device", async () => {
      await record("d1", 3);
      await record("d2", 2);
      const res = await call({ method: "GET", url: "/api/devices/d1/history" });
      assert.deepEqual(res.json().map((h: { state: { seq: number } }) => h.state.seq), [2, 1, 0]);
      assert.ok(res.json().every((h: { deviceId: string }) => h.deviceId === "d1"));
    });

    it("defaults to 50 entries and honours ?limit", async () => {
      await record("d1", 55);
      assert.equal((await call({ method: "GET", url: "/api/devices/d1/history" })).json().length, 50);
      assert.equal((await call({ method: "GET", url: "/api/devices/d1/history?limit=5" })).json().length, 5);
      assert.equal((await call({ method: "GET", url: "/api/devices/d1/history?limit=1000" })).json().length, 55);
    });

    for (const limit of ["0", "-1", "1001", "abc", "1.5", "1e9"]) {
      it(`rejects limit=${limit} with 400`, async () => {
        assert.equal((await call({ method: "GET", url: `/api/devices/d1/history?limit=${limit}` })).statusCode, 400);
      });
    }

    it("is empty (not 404) for unknown devices", async () => {
      const res = await call({ method: "GET", url: "/api/devices/nope/history" });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), []);
    });
  });

  describe("GET /api/devices/:id/profile", () => {
    it("passes the profile through", async () => {
      thinq.profile = { property: { operation: { mode: ["w"] } } };
      const res = await call({ method: "GET", url: "/api/devices/d1/profile" });
      assert.deepEqual(res.json(), { property: { operation: { mode: ["w"] } } });
    });

    it("hands the decoded id to the client, which escapes it for ThinQ", async () => {
      await call({ method: "GET", url: `/api/devices/${encodeURIComponent("../../devices")}/profile` });
      assert.deepEqual(thinq.calls.at(-1), { method: "getDeviceProfile", args: ["../../devices"] });
    });
  });

  describe("POST /api/devices/:id/control", () => {
    const command = { operation: { washerOperationMode: "START" } };
    const control = (payload: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
      call({ method: "POST", url: "/api/devices/d1/control", headers, payload: JSON.stringify(payload) });

    it("sends the command and logs a control event", async () => {
      const res = await control(command);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });
      assert.deepEqual(thinq.calls, [{ method: "controlDevice", args: ["d1", command] }]);
      const events = db.select().from(schema.events).all();
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, "control");
      assert.equal(events[0].deviceId, "d1");
      assert.deepEqual(events[0].payload, command);
    });

    it("returns ThinQ's result when it has one", async () => {
      thinq.controlResult = { accepted: true };
      assert.deepEqual((await control(command)).json(), { accepted: true });
    });

    for (const [name, body] of [
      ["an empty object", {}],
      ["an array", [command]],
      ["a string", "START"],
      ["a number", 1],
      ["null", null],
    ] as const) {
      it(`rejects ${name} without calling ThinQ`, async () => {
        const res = await control(body);
        assert.equal(res.statusCode, 400);
        assert.equal(thinq.calls.length, 0);
        assert.equal(db.select().from(schema.events).all().length, 0);
      });
    }

    it("rejects non-JSON content types", async () => {
      const res = await call({
        method: "POST",
        url: "/api/devices/d1/control",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "operation=START",
      });
      assert.equal(res.statusCode, 415);
      assert.equal(thinq.calls.length, 0);
    });

    it("rejects oversized bodies (413)", async () => {
      const res = await control({ blob: "x".repeat(1_100_000) });
      assert.equal(res.statusCode, 413);
      assert.equal(thinq.calls.length, 0);
    });

    it("does not log an event when ThinQ rejects the command", async () => {
      thinq.error = new ThinQError("bad value", "response", 400, "1102");
      const res = await control(command);
      assert.equal(res.statusCode, 502);
      assert.equal(res.json().thinqCode, "1102");
      assert.equal(db.select().from(schema.events).all().length, 0);
    });

    it("rejects prototype-polluting __proto__ keys", async () => {
      const res = await call({
        method: "POST",
        url: "/api/devices/d1/control",
        headers: { "content-type": "application/json" },
        payload: '{"__proto__": {"polluted": true}, "operation": {"mode": "START"}}',
      });
      // Fastify's JSON parser rejects __proto__ keys outright.
      assert.equal(res.statusCode, 400);
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
      assert.equal(thinq.calls.length, 0);
    });
  });
});
