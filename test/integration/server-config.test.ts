/**
 * The real server process and its settings: every setting is checked at
 * startup, invalid ones stop it with one clear message, and valid ones take
 * effect.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ApiClient, ROOT, startAppServer } from "../helpers/app-server.js";

const dir = mkdtempSync(join(tmpdir(), "lg-home-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function runServer(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, LOG_LEVEL: "error", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c) => (stdout += c));
    child.stderr!.on("data", (c) => (stderr += c));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("server settings", () => {
  it("refuses to start on invalid settings, listing all of them, before touching the database", async () => {
    const database = join(dir, "never", "created.db");
    const { code, stderr } = await runServer({
      DATABASE_PATH: database,
      PORT: "http",
      SESSION_TTL_HOURS: "forever",
      COOKIE_SECURE: "maybe",
      LOG_LEVEL: "loud",
    });
    assert.equal(code, 1);
    assert.match(stderr, /^Invalid configuration:/m);
    for (const name of ["PORT", "SESSION_TTL_HOURS", "COOKIE_SECURE", "LOG_LEVEL"]) assert.match(stderr, new RegExp(`- ${name} `), name);
    assert.doesNotMatch(stderr, /\n\s+at /, "a message, not a stack trace");
    assert.equal(existsSync(database), false);
  });

  it("applies valid settings: login lifetime and Secure cookies", async () => {
    const server = await startAppServer("http://127.0.0.1:9", { SESSION_TTL_HOURS: "1", COOKIE_SECURE: "true" });
    try {
      await server.addUser("alice", "secret123");
      const client = new ApiClient(server.base);
      const { res, status } = await client.request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "alice", password: "secret123" }),
      });
      assert.equal(status, 200);
      const cookie = res.headers.get("set-cookie") ?? "";
      const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
      assert.ok(maxAge >= 3599 && maxAge <= 3600, `Max-Age ${maxAge}`);
      assert.match(cookie, /; Secure/, "Secure even over plain HTTP");
    } finally {
      await server.stop();
    }
  });
});
