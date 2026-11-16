/**
 * Integration test: boots the real server (via tsx) against the fake ThinQ API
 * (fridge + dishwasher) and a throwaway SQLite database, provisions a user
 * with the add_user CLI, and drives the HTTP API the way the SPA does.
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { DISHWASHER_ID, FRIDGE_ID } from "../fake-thinq/devices.js";
import { FakeThinQ } from "../fake-thinq/server.js";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "../..");
const MINUTE = 60_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

describe("server against the fake ThinQ API", () => {
  let clock = Date.parse("2026-01-01T08:00:00Z");
  const fake = new FakeThinQ({ accessToken: "pat-test", now: () => clock });
  const dataDir = mkdtempSync(join(tmpdir(), "lg-home-test-"));
  const env = { ...process.env, DATABASE_PATH: join(dataDir, "test.db"), LOG_LEVEL: "error" };
  let server: ChildProcess;
  let base = "";
  let cookie = "";

  async function api(path: string, init: RequestInit = {}) {
    const headers: Record<string, string> = {};
    if (init.body) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    return { res, status: res.status, body: text ? JSON.parse(text) : null };
  }

  const control = (id: string, command: unknown) =>
    api(`/api/devices/${id}/control`, { method: "POST", body: JSON.stringify(command) });

  before(async () => {
    await fake.listen();

    // Provision the login with the admin CLI, exactly as an operator would.
    const cli = await run(
      process.execPath,
      ["--import", "tsx", "src/server/cli/add-user.ts", "alice", "--password", "secret123"],
      { cwd: ROOT, env },
    );
    assert.match(cli.stdout, /Created user "alice"/);

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
      cwd: ROOT,
      env: {
        ...env,
        PORT: String(port),
        THINQ_ACCESS_TOKEN: "pat-test",
        THINQ_COUNTRY_CODE: "US",
        THINQ_API_BASE_URL: fake.url,
      },
      stdio: ["ignore", "inherit", "inherit"],
    });

    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`${base}/api/auth/me`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("server did not start");
  });

  after(async () => {
    server?.kill();
    await fake.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("authentication", () => {
    it("refuses API calls without a session and never reaches ThinQ", async () => {
      assert.equal((await api("/api/devices")).status, 401);
      assert.equal((await api("/api/devices/sync", { method: "POST" })).status, 401);
      assert.equal((await control(FRIDGE_ID, { powerSave: { powerSaveEnabled: true } })).status, 401);
      assert.equal(fake.requests.length, 0);
    });

    it("rejects wrong credentials with a generic message", async () => {
      for (const [username, password] of [
        ["alice", "wrong-password"],
        ["mallory", "secret123"],
      ]) {
        const { status, body } = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ username, password }),
        });
        assert.equal(status, 401);
        assert.equal(body.error, "Invalid username or password");
      }
    });

    it("logs in and sets an HttpOnly session cookie", async () => {
      const { res, status, body } = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "alice", password: "secret123" }),
      });
      assert.equal(status, 200);
      assert.equal(body.user.username, "alice");
      const setCookie = res.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /^lg_home_session=[^;]+/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Lax/);
      cookie = setCookie.split(";")[0];
      assert.equal((await api("/api/auth/me")).body.user.username, "alice");
    });
  });

  describe("devices", () => {
    it("starts with an empty local device list", async () => {
      assert.deepEqual((await api("/api/devices")).body, []);
    });

    it("syncs the fridge and the dishwasher from ThinQ", async () => {
      const { status, body } = await api("/api/devices/sync", { method: "POST" });
      assert.equal(status, 200);
      assert.deepEqual(
        body.map((d: { id: string; type: string; alias: string; modelName: string }) => [d.alias, d.type, d.id, d.modelName]),
        [
          ["Dishwasher", "DEVICE_DISH_WASHER", DISHWASHER_ID, "DFB532FP"],
          ["Kitchen Fridge", "DEVICE_REFRIGERATOR", FRIDGE_ID, "GBB92STAXP"],
        ],
      );
      // Persisted: the plain list endpoint now serves them from SQLite.
      assert.equal((await api("/api/devices")).body.length, 2);
    });

    it("re-syncing updates rather than duplicates", async () => {
      const { body } = await api("/api/devices/sync", { method: "POST" });
      assert.equal(body.length, 2);
    });

    it("reads live fridge status and records history", async () => {
      const { status, body } = await api(`/api/devices/${FRIDGE_ID}/status`);
      assert.equal(status, 200);
      assert.deepEqual(body.temperature, [
        { locationName: "FRIDGE", targetTemperature: 3, unit: "C" },
        { locationName: "FREEZER", targetTemperature: -18, unit: "C" },
      ]);
      const history = await api(`/api/devices/${FRIDGE_ID}/history`);
      assert.equal(history.body.length, 1);
      assert.deepEqual(history.body[0].state, body);
    });

    it("serves device profiles", async () => {
      const { status, body } = await api(`/api/devices/${DISHWASHER_ID}/profile`);
      assert.equal(status, 200);
      assert.deepEqual(body.property.operation.dishWasherOperationMode.value.w, ["START", "STOP", "POWER_OFF"]);
    });

    it("404s status for a device that was never synced, without calling ThinQ", async () => {
      const before = fake.requests.length;
      assert.equal((await api("/api/devices/unknown/status")).status, 404);
      assert.equal(fake.requests.length, before);
    });
  });

  describe("fridge control", () => {
    it("sets the freezer temperature", async () => {
      const command = { temperature: { locationName: "FREEZER", targetTemperature: -21, unit: "C" } };
      const { status, body } = await control(FRIDGE_ID, command);
      assert.equal(status, 200);
      assert.deepEqual(body, { ok: true });

      const sent = fake.requests.at(-1)!;
      assert.equal(sent.path, `/devices/${FRIDGE_ID}/control`);
      assert.equal(sent.headers["x-conditional-control"], "true");
      assert.deepEqual(sent.body, command);

      const state = (await api(`/api/devices/${FRIDGE_ID}/status`)).body;
      assert.equal(state.temperature[1].targetTemperature, -21);
    });

    it("passes ThinQ's rejection of an invalid command through as 502", async () => {
      const { status, body } = await control(FRIDGE_ID, { temperature: { locationName: "FRIDGE", targetTemperature: 20 } });
      assert.equal(status, 502);
      assert.equal(body.thinqStatus, 400);
      assert.equal(body.thinqCode, "1102");
      assert.match(body.error, /1\.\.7/);
    });

    it("rejects an empty command before reaching ThinQ", async () => {
      const before = fake.requests.length;
      assert.equal((await control(FRIDGE_ID, {})).status, 400);
      assert.equal(fake.requests.length, before);
    });

    it("reports a disconnected fridge", async () => {
      fake.device(FRIDGE_ID)!.online = false;
      try {
        const { status, body } = await api(`/api/devices/${FRIDGE_ID}/status`);
        assert.equal(status, 502);
        assert.equal(body.thinqCode, "1222");
      } finally {
        fake.device(FRIDGE_ID)!.online = true;
      }
    });
  });

  describe("dishwasher control", () => {
    const start = { operation: { dishWasherOperationMode: "START" } };

    it("cannot start until remote start is enabled on the appliance", async () => {
      const { status, body } = await control(DISHWASHER_ID, start);
      assert.equal(status, 502);
      assert.equal(body.thinqCode, "2301");
    });

    it("runs a full programme", async () => {
      // Someone presses "remote start" on the dishwasher.
      fake.device(DISHWASHER_ID)!.patchState({ remoteControlEnable: { remoteControlEnabled: true } });
      assert.equal((await control(DISHWASHER_ID, start)).status, 200);

      let state = (await api(`/api/devices/${DISHWASHER_ID}/status`)).body;
      assert.equal(state.runState.currentState, "RUNNING");
      assert.deepEqual(state.timer, { remainHour: 2, remainMinute: 15, totalHour: 2, totalMinute: 15 });

      clock += 90 * MINUTE;
      state = (await api(`/api/devices/${DISHWASHER_ID}/status`)).body;
      assert.equal(state.timer.remainMinute + state.timer.remainHour * 60, 45);

      clock += 45 * MINUTE;
      state = (await api(`/api/devices/${DISHWASHER_ID}/status`)).body;
      assert.equal(state.runState.currentState, "END");

      const history = (await api(`/api/devices/${DISHWASHER_ID}/history`)).body;
      assert.deepEqual(
        history.map((h: { state: { runState: { currentState: string } } }) => h.state.runState.currentState),
        ["END", "RUNNING", "RUNNING"],
        "history is newest first",
      );
    });
  });

  describe("ThinQ protocol", () => {
    it("used one stable client id and a fresh message id per call", () => {
      const clientIds = new Set(fake.requests.map((r) => r.headers["x-client-id"]));
      assert.equal(clientIds.size, 1);
      assert.match([...clientIds][0], /^[0-9a-f-]{36}$/);
      const messageIds = fake.requests.map((r) => r.headers["x-message-id"]);
      assert.equal(new Set(messageIds).size, messageIds.length);
      assert.ok(fake.requests.every((r) => r.headers.authorization === "Bearer pat-test" && r.headers["x-country"] === "US"));
    });
  });

  describe("logout", () => {
    it("invalidates the session", async () => {
      const { res, status } = await api("/api/auth/logout", { method: "POST" });
      assert.equal(status, 200);
      assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=0/);
      assert.equal((await api("/api/devices")).status, 401);
    });
  });
});
