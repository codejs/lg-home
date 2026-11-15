/**
 * Boots the real server (via tsx) against a mock ThinQ API and a throwaway
 * SQLite database, provisions a user with the add_user CLI, and drives the
 * HTTP API the way the SPA does.
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { MockThinQ, fail, ok } from "./helpers/mock-thinq.js";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

const DEVICE = {
  deviceId: "dev-1",
  deviceInfo: { deviceType: "DEVICE_AIR_CONDITIONER", modelName: "AC-01", alias: "Living room AC", reportable: true },
};

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

describe("server", () => {
  const mock = new MockThinQ();
  const dataDir = mkdtempSync(join(tmpdir(), "lg-home-test-"));
  const env = { ...process.env, DATABASE_PATH: join(dataDir, "test.db"), LOG_LEVEL: "error" };
  let server: ChildProcess;
  let base = "";
  let cookie = "";

  async function api(path: string, init: RequestInit & { auth?: boolean } = {}) {
    const headers: Record<string, string> = {};
    if (init.body) headers["Content-Type"] = "application/json";
    if (init.auth !== false && cookie) headers.Cookie = cookie;
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    return { res, status: res.status, body: text ? JSON.parse(text) : null };
  }

  before(async () => {
    await mock.start();
    mock.handler = (req) => {
      if (req.method === "GET" && req.url === "/devices") return ok([DEVICE]);
      if (req.method === "GET" && req.url === "/devices/dev-1/state") return ok({ operation: { airConOperationMode: "POWER_ON" } });
      if (req.method === "GET" && req.url === "/devices/dev-1/profile") return ok({ property: { operation: {} } });
      if (req.method === "POST" && req.url === "/devices/dev-1/control") return ok({});
      return fail(404, "1100", "Not found");
    };

    // Provision the login with the admin CLI, exactly as an operator would.
    const cli = await run(process.execPath, ["--import", "tsx", "src/server/cli/add-user.ts", "alice", "--password", "secret123"], {
      cwd: ROOT,
      env,
    });
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
        THINQ_API_BASE_URL: mock.url,
      },
      stdio: ["ignore", "inherit", "inherit"],
    });

    // Wait for the server to accept connections.
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
    await mock.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses API calls without a session", async () => {
    assert.equal((await api("/api/devices")).status, 401);
    assert.equal((await api("/api/devices/sync", { method: "POST" })).status, 401);
    assert.equal((await api("/api/auth/me")).status, 401);
    assert.equal(mock.requests.length, 0, "ThinQ must not be called for anonymous requests");
  });

  it("rejects a wrong password with an error message", async () => {
    const { status, body } = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "alice", password: "wrong-password" }),
    });
    assert.equal(status, 401);
    assert.equal(body.error, "Invalid username or password");
  });

  it("rejects an unknown user with the same message", async () => {
    const { status, body } = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "mallory", password: "secret123" }),
    });
    assert.equal(status, 401);
    assert.equal(body.error, "Invalid username or password");
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

    const me = await api("/api/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, "alice");
  });

  it("syncs devices from ThinQ into the database", async () => {
    const { status, body } = await api("/api/devices/sync", { method: "POST" });
    assert.equal(status, 200);
    assert.equal(body.length, 1);
    assert.equal(body[0].id, "dev-1");
    assert.equal(body[0].alias, "Living room AC");
    assert.equal(body[0].type, "DEVICE_AIR_CONDITIONER");

    const list = await api("/api/devices");
    assert.deepEqual(
      list.body.map((d: { id: string }) => d.id),
      ["dev-1"],
    );

    const call = mock.requests.at(-1)!;
    assert.equal(call.headers.authorization, "Bearer pat-test");
    assert.equal(call.headers["x-country"], "US");
  });

  it("reads live status and records it in the history", async () => {
    const { status, body } = await api("/api/devices/dev-1/status");
    assert.equal(status, 200);
    assert.deepEqual(body, { operation: { airConOperationMode: "POWER_ON" } });

    const history = await api("/api/devices/dev-1/history");
    assert.equal(history.body.length, 1);
    assert.deepEqual(history.body[0].state, body);
  });

  it("returns the device profile", async () => {
    const { status, body } = await api("/api/devices/dev-1/profile");
    assert.equal(status, 200);
    assert.deepEqual(body, { property: { operation: {} } });
  });

  it("sends control commands", async () => {
    const command = { operation: { airConOperationMode: "POWER_OFF" } };
    const { status, body } = await api("/api/devices/dev-1/control", {
      method: "POST",
      body: JSON.stringify(command),
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    const call = mock.requests.at(-1)!;
    assert.equal(call.url, "/devices/dev-1/control");
    assert.deepEqual(call.body, command);
  });

  it("maps ThinQ errors to 502 with the ThinQ code", async () => {
    const { status, body } = await api("/api/devices/offline/profile");
    assert.equal(status, 502);
    assert.equal(body.thinqStatus, 404);
    assert.equal(body.thinqCode, "1100");
  });

  it("keeps one stable ThinQ client id", () => {
    const ids = new Set(mock.requests.map((r) => r.headers["x-client-id"]));
    assert.equal(ids.size, 1);
    assert.match(String([...ids][0]), /^[0-9a-f-]{36}$/);
  });

  it("logs out and invalidates the session", async () => {
    const { res, status } = await api("/api/auth/logout", { method: "POST" });
    assert.equal(status, 200);
    assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal((await api("/api/devices")).status, 401, "old cookie must no longer work");
  });
});
