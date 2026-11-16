/**
 * Contract tests for the fake ThinQ API, driven through the app's real
 * ThinQClient so the client and the fake are checked against each other.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { ThinQClient, ThinQError, type JsonObject } from "../src/server/thinq/client.js";
import { DISHWASHER_ID, FRIDGE_ID } from "./fake-thinq/devices.js";
import { ERRORS, THINQ_ERROR_CODES } from "./fake-thinq/protocol.js";
import { FakeThinQ, THINQ_PUBLIC_API_KEY } from "./fake-thinq/server.js";

const MINUTE = 60_000;

/** Assert that a promise rejects with a ThinQError carrying this status and code. */
async function rejectsWith(promise: Promise<unknown>, status: number, code: string, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ThinQError, `expected ThinQError, got ${err}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

describe("fake ThinQ API", () => {
  let clock = Date.parse("2026-01-01T08:00:00Z");
  const fake = new FakeThinQ({ accessToken: "pat-test", now: () => clock });
  let client: ThinQClient;

  const headers = (overrides: Record<string, string | undefined> = {}) => {
    const h: Record<string, string | undefined> = {
      Authorization: "Bearer pat-test",
      "x-country": "US",
      "x-client-id": "client-1",
      "x-api-key": THINQ_PUBLIC_API_KEY,
      "x-service-phase": "OP",
      "x-message-id": randomBytes(16).toString("base64url"),
      ...overrides,
    };
    return Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)) as Record<string, string>;
  };

  before(async () => {
    await fake.listen();
    client = new ThinQClient({ accessToken: "pat-test", countryCode: "US", clientId: "client-1", baseUrl: fake.url });
  });
  after(() => fake.close());
  beforeEach(() => {
    fake.reset();
    clock = Date.parse("2026-01-01T08:00:00Z");
  });

  describe("devices", () => {
    it("lists one refrigerator and one dishwasher", async () => {
      const devices = await client.getDevices();
      assert.equal(devices.length, 2);
      const byType = Object.fromEntries(devices.map((d) => [d.deviceInfo.deviceType, d]));
      assert.deepEqual(Object.keys(byType).sort(), ["DEVICE_DISH_WASHER", "DEVICE_REFRIGERATOR"]);
      assert.equal(byType.DEVICE_REFRIGERATOR.deviceId, FRIDGE_ID);
      assert.equal(byType.DEVICE_DISH_WASHER.deviceId, DISHWASHER_ID);
      for (const d of devices) {
        assert.match(d.deviceId, /^[0-9a-f]{64}$/);
        assert.ok(d.deviceInfo.alias && d.deviceInfo.modelName);
        assert.equal(d.deviceInfo.reportable, true);
      }
    });

    it("serves profiles describing readable and writable properties", async () => {
      const fridge = await client.getDeviceProfile(FRIDGE_ID);
      const temps = (fridge.property as JsonObject).temperature as JsonObject[];
      assert.deepEqual(temps.map((t) => t.locationName), ["FRIDGE", "FREEZER"]);
      assert.deepEqual((temps[0].targetTemperature as JsonObject).mode, ["r", "w"]);

      const dishwasher = await client.getDeviceProfile(DISHWASHER_ID);
      const operation = (dishwasher.property as JsonObject).operation as JsonObject;
      assert.deepEqual((operation.dishWasherOperationMode as JsonObject).mode, ["w"]);
    });

    it("serves initial state", async () => {
      const fridge = await client.getDeviceStatus(FRIDGE_ID);
      assert.deepEqual(fridge.temperature, [
        { locationName: "FRIDGE", targetTemperature: 3, unit: "C" },
        { locationName: "FREEZER", targetTemperature: -18, unit: "C" },
      ]);
      assert.deepEqual(fridge.doorStatus, [{ locationName: "MAIN", doorState: "CLOSE" }]);

      const dishwasher = await client.getDeviceStatus(DISHWASHER_ID);
      assert.deepEqual(dishwasher.runState, { currentState: "INITIAL" });
      assert.deepEqual(dishwasher.remoteControlEnable, { remoteControlEnabled: false });
    });

    it("returns 404 for unknown devices", async () => {
      await rejectsWith(client.getDeviceStatus("nope"), 404, "1205");
    });

    it("reports offline devices as not connected", async () => {
      fake.device(FRIDGE_ID)!.online = false;
      await rejectsWith(client.getDeviceStatus(FRIDGE_ID), 400, "1222");
      await rejectsWith(client.controlDevice(FRIDGE_ID, { powerSave: { powerSaveEnabled: true } }), 400, "1222");
      // The profile is cloud data and stays available.
      await client.getDeviceProfile(FRIDGE_ID);
    });
  });

  describe("request validation", () => {
    it("rejects a wrong token", async () => {
      const wrong = new ThinQClient({ accessToken: "stolen", countryCode: "US", clientId: "c", baseUrl: fake.url });
      await rejectsWith(wrong.getDevices(), 401, "1103");
    });

    it("rejects a wrong api key", async () => {
      const wrong = new ThinQClient({ accessToken: "pat-test", countryCode: "US", clientId: "c", baseUrl: fake.url, apiKey: "x" });
      await rejectsWith(wrong.getDevices(), 400, "1216");
    });

    for (const header of ["x-country", "x-client-id", "x-api-key", "x-service-phase", "x-message-id"]) {
      it(`requires the ${header} header`, async () => {
        const res = await fetch(`${fake.url}/devices`, { headers: headers({ [header]: undefined }) });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error.code, "1101");
      });
    }

    it("rejects malformed and reused message ids", async () => {
      const bad = await fetch(`${fake.url}/devices`, { headers: headers({ "x-message-id": "not-valid" }) });
      assert.equal((await bad.json()).error.code, "1104");

      const h = headers();
      assert.equal((await fetch(`${fake.url}/devices`, { headers: h })).status, 200);
      const replay = await fetch(`${fake.url}/devices`, { headers: h });
      assert.equal(replay.status, 400);
      assert.equal((await replay.json()).error.code, "1104");
    });

    it("echoes the message id in the envelope", async () => {
      const h = headers();
      const body = await (await fetch(`${fake.url}/devices`, { headers: h })).json();
      assert.equal(body.messageId, h["x-message-id"]);
      assert.ok(Array.isArray(body.response));
      assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
    });

    it("rejects bodies that are not JSON", async () => {
      const res = await fetch(`${fake.url}/devices/${FRIDGE_ID}/control`, {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: "{oops",
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, "1000");
    });

    it("records every request", async () => {
      await client.getDevices();
      await client.getDeviceStatus("nope").catch(() => {});
      assert.deepEqual(
        fake.requests.map((r) => [r.method, r.path, r.status]),
        [
          ["GET", "/devices", 200],
          ["GET", "/devices/nope/state", 404],
        ],
      );
      assert.equal(fake.requests[0].headers["x-client-id"], "client-1");
    });
  });

  describe("refrigerator control", () => {
    it("changes compartment temperatures within range", async () => {
      await client.controlDevice(FRIDGE_ID, { temperature: { locationName: "FREEZER", targetTemperature: -20, unit: "C" } });
      const state = await client.getDeviceStatus(FRIDGE_ID);
      assert.deepEqual(state.temperature, [
        { locationName: "FRIDGE", targetTemperature: 3, unit: "C" },
        { locationName: "FREEZER", targetTemperature: -20, unit: "C" },
      ]);
    });

    it("toggles switches", async () => {
      await client.controlDevice(FRIDGE_ID, { refrigeration: { expressMode: true, freshAirFilter: "POWER" } });
      const state = await client.getDeviceStatus(FRIDGE_ID);
      assert.deepEqual(state.refrigeration, { expressMode: true, expressFridge: false, freshAirFilter: "POWER" });
    });

    const invalid: [string, JsonObject, string, RegExp][] = [
      ["an empty command", {}, "1101", /non-empty/],
      ["an unknown resource", { turbo: { on: true } }, "1102", /Unknown resource/],
      ["an unknown property", { powerSave: { nope: true } }, "1102", /Unknown property/],
      ["a missing locationName", { temperature: { targetTemperature: 4 } }, "1101", /locationName/],
      ["an unknown location", { temperature: { locationName: "CELLAR", targetTemperature: 4 } }, "1102", /CELLAR/],
      ["a temperature out of range", { temperature: { locationName: "FRIDGE", targetTemperature: 12 } }, "1102", /1\.\.7/],
      ["a fractional step", { temperature: { locationName: "FRIDGE", targetTemperature: 3.5 } }, "1102", /multiple of 1/],
      ["a wrong type", { powerSave: { powerSaveEnabled: "yes" } }, "1102", /boolean/],
      ["a read-only property", { doorStatus: { locationName: "MAIN", doorState: "OPEN" } }, "1102", /read-only/],
      ["a read-only value change", { temperature: { locationName: "FRIDGE", targetTemperature: 4, unit: "F" } }, "1102", /read-only/],
      ["a read-only-only enum value", { refrigeration: { freshAirFilter: "REPLACE" } }, "1102", /OFF, AUTO, POWER/],
    ];
    for (const [name, command, code, message] of invalid) {
      it(`rejects ${name} and leaves state untouched`, async () => {
        const before = await client.getDeviceStatus(FRIDGE_ID);
        await rejectsWith(client.controlDevice(FRIDGE_ID, command), 400, code, message);
        assert.deepEqual(await client.getDeviceStatus(FRIDGE_ID), before);
      });
    }

    it("locks controls in sabbath mode", async () => {
      fake.device(FRIDGE_ID)!.patchState({ sabbath: { sabbathMode: true } });
      await rejectsWith(client.controlDevice(FRIDGE_ID, { powerSave: { powerSaveEnabled: true } }), 400, "2302", /sabbath/);
    });
  });

  describe("dishwasher control", () => {
    const start = { operation: { dishWasherOperationMode: "START" } };
    const enableRemote = () => fake.device(DISHWASHER_ID)!.patchState({ remoteControlEnable: { remoteControlEnabled: true } });

    it("needs remote start enabled on the appliance", async () => {
      await rejectsWith(client.controlDevice(DISHWASHER_ID, start), 400, "2301");
    });

    it("refuses to start with the door open", async () => {
      enableRemote();
      fake.device(DISHWASHER_ID)!.patchState({ doorStatus: { doorState: "OPEN" } });
      await rejectsWith(client.controlDevice(DISHWASHER_ID, start), 400, "2302", /door/);
    });

    it("runs a programme to completion as time passes", async () => {
      enableRemote();
      await client.controlDevice(DISHWASHER_ID, start);
      let state = await client.getDeviceStatus(DISHWASHER_ID);
      assert.deepEqual(state.runState, { currentState: "RUNNING" });
      assert.deepEqual(state.timer, { remainHour: 2, remainMinute: 15, totalHour: 2, totalMinute: 15 });

      clock += 60 * MINUTE;
      state = await client.getDeviceStatus(DISHWASHER_ID);
      assert.deepEqual(state.timer, { remainHour: 1, remainMinute: 15, totalHour: 2, totalMinute: 15 });
      await rejectsWith(client.controlDevice(DISHWASHER_ID, start), 400, "2302", /RUNNING/);

      clock += 75 * MINUTE;
      state = await client.getDeviceStatus(DISHWASHER_ID);
      assert.deepEqual(state.runState, { currentState: "END" });
      assert.equal((state.timer as JsonObject).remainMinute, 0);
    });

    it("uses the programme length of the selected course", async () => {
      enableRemote();
      fake.device(DISHWASHER_ID)!.patchState({ dishWashingCourse: { currentDishWashingCourse: "QUICK" } });
      await client.controlDevice(DISHWASHER_ID, start);
      assert.deepEqual((await client.getDeviceStatus(DISHWASHER_ID)).timer, {
        remainHour: 0,
        remainMinute: 30,
        totalHour: 0,
        totalMinute: 30,
      });
    });

    it("stops a running programme", async () => {
      enableRemote();
      await client.controlDevice(DISHWASHER_ID, start);
      await client.controlDevice(DISHWASHER_ID, { operation: { dishWasherOperationMode: "STOP" } });
      assert.deepEqual((await client.getDeviceStatus(DISHWASHER_ID)).runState, { currentState: "INITIAL" });
      await rejectsWith(client.controlDevice(DISHWASHER_ID, { operation: { dishWasherOperationMode: "STOP" } }), 400, "2302");
    });

    it("powers off, after which it cannot be started remotely", async () => {
      enableRemote();
      await client.controlDevice(DISHWASHER_ID, { operation: { dishWasherOperationMode: "POWER_OFF" } });
      const state = await client.getDeviceStatus(DISHWASHER_ID);
      assert.deepEqual(state.runState, { currentState: "POWER_OFF" });
      assert.deepEqual(state.remoteControlEnable, { remoteControlEnabled: false });
      await rejectsWith(client.controlDevice(DISHWASHER_ID, start), 400, "2304", /off/);
    });

    it("rejects unknown operation modes", async () => {
      await rejectsWith(client.controlDevice(DISHWASHER_ID, { operation: { dishWasherOperationMode: "DANCE" } }), 400, "1102");
    });
  });

  describe("error codes", () => {
    it("only uses official ThinQ error codes, under their official names", () => {
      for (const [name, { code }] of Object.entries(ERRORS)) {
        assert.equal(code, THINQ_ERROR_CODES[name as keyof typeof THINQ_ERROR_CODES], `${name} has the wrong code`);
      }
    });

    it("keeps official codes unique", () => {
      const codes = Object.values(THINQ_ERROR_CODES);
      assert.equal(new Set(codes).size, codes.length);
    });

    it("answers unknown endpoints with 404 and the generic BAD_REQUEST code", async () => {
      const res = await fetch(`${fake.url}/devices/${FRIDGE_ID}/nonsense`, { headers: headers() });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, "1000");
    });
  });

  describe("fault injection", () => {
    it("fails the next matching request once by default, then recovers", async () => {
      fake.injectFault({ error: "EXCEEDED_API_CALLS" });
      await rejectsWith(client.getDevices(), 429, "1306", /Injected fault/);
      assert.equal((await client.getDevices()).length, 2);
      assert.deepEqual(
        fake.requests.map((r) => [r.path, r.status, r.errorCode]),
        [
          ["/devices", 429, "1306"],
          ["/devices", 200, undefined],
        ],
      );
    });

    it("matches on method and exact path or pattern", async () => {
      fake.injectFault({ error: "NOT_CONNECTED_DEVICE", method: "get", path: `/devices/${FRIDGE_ID}/state`, times: 2 });
      fake.injectFault({ error: "INTERNAL_SERVER_ERROR", path: /\/control$/ });
      await client.getDeviceStatus(DISHWASHER_ID); // other path: untouched
      await client.getDeviceProfile(FRIDGE_ID); // other path: untouched
      await rejectsWith(client.getDeviceStatus(FRIDGE_ID), 400, "1222");
      await rejectsWith(client.getDeviceStatus(FRIDGE_ID), 400, "1222");
      await client.getDeviceStatus(FRIDGE_ID);
      await rejectsWith(client.controlDevice(FRIDGE_ID, { powerSave: { powerSaveEnabled: true } }), 500, "2000");
      assert.deepEqual((await client.getDeviceStatus(FRIDGE_ID)).powerSave, { powerSaveEnabled: false }, "failed control changed nothing");
    });

    it("keeps failing with times: Infinity until cleared", async () => {
      fake.injectFault({ error: "INVALID_TOKEN", times: Infinity });
      for (let i = 0; i < 3; i++) await rejectsWith(client.getDevices(), 401, "1103");
      fake.clearFaults();
      await client.getDevices();
    });

    it("still checks the request headers first", async () => {
      fake.injectFault({ error: "EXCEEDED_API_CALLS" });
      const wrong = new ThinQClient({ accessToken: "stolen", countryCode: "US", clientId: "c", baseUrl: fake.url });
      await rejectsWith(wrong.getDevices(), 401, "1103");
      assert.equal(fake.pendingFaults.length, 1, "fault not used up by an unauthenticated request");
    });

    it("is cleared by reset", async () => {
      fake.injectFault({ error: "EXCEEDED_API_CALLS", times: Infinity });
      fake.reset();
      await client.getDevices();
    });

    it("rejects invalid fault specs in-process", () => {
      assert.throws(() => fake.injectFault({ error: "NOPE" as "BAD_REQUEST" }), /Unknown fake error kind/);
      assert.throws(() => fake.injectFault({ error: "BAD_REQUEST", times: 0 }), /positive integer/);
      assert.throws(() => fake.injectFault({ error: "BAD_REQUEST", times: 1.5 }), /positive integer/);
    });

    it("can be driven over HTTP", async () => {
      const post = (body: unknown) =>
        fetch(`${fake.url}/__fake/faults`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

      for (const bad of [{}, { error: "NOPE" }, { error: "toString" }, { error: "BAD_REQUEST", times: 0 }, { error: "BAD_REQUEST", path: 5 }]) {
        assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
      }
      const created = await post({ error: "EXCEEDED_API_CALLS", path: "/devices", times: "always" });
      assert.equal(created.status, 201);
      assert.deepEqual(await created.json(), [{ error: "EXCEEDED_API_CALLS", path: "/devices", remaining: "always" }]);

      await rejectsWith(client.getDevices(), 429, "1306");
      await rejectsWith(client.getDevices(), 429, "1306");
      assert.equal((await (await fetch(`${fake.url}/__fake/faults`)).json()).length, 1);

      assert.equal((await fetch(`${fake.url}/__fake/faults`, { method: "DELETE" })).status, 200);
      assert.deepEqual(await (await fetch(`${fake.url}/__fake/faults`)).json(), []);
      await client.getDevices();
    });
  });

  describe("scenario endpoints", () => {
    it("patch device state and connectivity over HTTP", async () => {
      const res = await fetch(`${fake.url}/__fake/devices/${FRIDGE_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: { doorStatus: [{ locationName: "MAIN", doorState: "OPEN" }] } }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual((await client.getDeviceStatus(FRIDGE_ID)).doorStatus, [{ locationName: "MAIN", doorState: "OPEN" }]);

      await fetch(`${fake.url}/__fake/devices/${FRIDGE_ID}`, { method: "PATCH", body: JSON.stringify({ online: false }) });
      await rejectsWith(client.getDeviceStatus(FRIDGE_ID), 400, "1222");
    });

    it("list requests and reset over HTTP", async () => {
      await client.controlDevice(FRIDGE_ID, { powerSave: { powerSaveEnabled: true } });
      const log = await (await fetch(`${fake.url}/__fake/requests`)).json();
      assert.equal(log.length, 1);
      assert.deepEqual(log[0].body, { powerSave: { powerSaveEnabled: true } });

      await fetch(`${fake.url}/__fake/reset`, { method: "POST" });
      assert.deepEqual((await client.getDeviceStatus(FRIDGE_ID)).powerSave, { powerSaveEnabled: false });
      assert.equal(fake.requests.length, 1, "log restarts after reset");
    });
  });
});
