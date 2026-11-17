/**
 * The add_user CLI as operators run it: a real process with argv, stdin, env
 * and exit codes, against a throwaway database.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { scryptSync, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import { ROOT } from "../helpers/app-server.js";

const dir = mkdtempSync(join(tmpdir(), "lg-home-cli-"));
const dbPath = join(dir, "cli.db");

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function addUser(args: string[], options: { stdin?: string; env?: Record<string, string> } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server/cli/add-user.ts", ...args], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_PATH: dbPath, ADD_USER_PASSWORD: "", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.stdin ?? "");
  });
}

function users(): { username: string; password_hash: string }[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("select username, password_hash from users order by username").all() as never;
  } finally {
    db.close();
  }
}

/** Independent check of a stored `scrypt$N$r$p$salt$hash` digest. */
function matches(password: string, stored: string): boolean {
  const [, n, r, p, salt, hash] = stored.split("$");
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

describe("add_user CLI", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("--help prints usage and exits 0 without touching the database", async () => {
    const untouched = join(dir, "help", "untouched.db");
    const res = await addUser(["--help"], { env: { DATABASE_PATH: untouched } });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /Usage: npm run add_user/);
    assert.equal(existsSync(untouched), false, "no database file created");
  });

  it("doesn't create a database for invalid input either", async () => {
    const untouched = join(dir, "invalid", "untouched.db");
    const res = await addUser(["x", "--password", "secret123"], { env: { DATABASE_PATH: untouched } });
    assert.equal(res.code, 1);
    assert.equal(existsSync(untouched), false);
  });

  it("ignores server settings it doesn't use, even invalid ones", async () => {
    const own = join(dir, "own.db");
    const res = await addUser(["carol", "--password", "secret123"], {
      env: {
        DATABASE_PATH: own,
        SESSION_TTL_HOURS: "forever",
        EVENT_POLL_INTERVAL_SECONDS: "1",
        PORT: "http",
        COOKIE_SECURE: "maybe",
        LOG_LEVEL: "loud",
      },
    });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Created user "carol"/);
    const db = new Database(own, { readonly: true });
    try {
      assert.deepEqual(db.prepare("SELECT username FROM users").all(), [{ username: "carol" }]);
    } finally {
      db.close();
    }
  });

  it("creates a user with --password", async () => {
    const res = await addUser(["Alice", "--password", "secret123"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Created user "alice"/);
    assert.deepEqual(users().map((u) => u.username), ["alice"]);
    assert.ok(!users()[0].password_hash.includes("secret123"));
  });

  it("refuses duplicates with exit code 1 and leaves the user unchanged", async () => {
    const before = users()[0].password_hash;
    const res = await addUser(["alice", "-p", "another-one"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /already exists.*--force/);
    assert.equal(users()[0].password_hash, before);
  });

  it("--force replaces the password", async () => {
    const before = users()[0].password_hash;
    const res = await addUser(["alice", "-p", "new-secret-1", "--force"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Updated password for "alice".*signed out/);
    assert.notEqual(users()[0].password_hash, before);
  });

  it("reads a piped password, keeping surrounding spaces", async () => {
    const res = await addUser(["piper"], { stdin: "  spaced pass  \nignored second line\n" });
    assert.equal(res.code, 0, res.stderr);
    const hash = users().find((u) => u.username === "piper")!.password_hash;
    assert.equal(matches("  spaced pass  ", hash), true);
    assert.equal(matches("spaced pass", hash), false, "spaces were not trimmed");
  });

  it("reads ADD_USER_PASSWORD from the environment", async () => {
    const res = await addUser(["envuser"], { env: { ADD_USER_PASSWORD: "from-env-123" } });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(users().some((u) => u.username === "envuser"));
  });

  const failures: [string, string[], RegExp, string?][] = [
    ["no username", [], /Usage/],
    ["-p without a value", ["bob", "-p"], /-p requires a value/],
    ["an unknown option", ["bob", "--admin"], /Unknown option/],
    ["an invalid username", ["b!", "-p", "secret123"], /Username must be/],
    ["a short password", ["bob", "-p", "short"], /at least 8/],
    ["a password over the login limit", ["bob", "-p", "x".repeat(1025)], /at most 1024/],
    ["an empty piped password", ["bob"], /at least 8/, "\n"],
  ];
  for (const [name, args, message, stdin] of failures) {
    it(`exits 1 on ${name}, writing nothing`, async () => {
      const before = users().length;
      const res = await addUser(args, { stdin });
      assert.equal(res.code, 1, res.stdout);
      assert.match(res.stderr, message);
      assert.equal(res.stdout, "");
      assert.equal(users().length, before);
    });
  }

  it("validates the username before reading a password", async () => {
    // stdin would provide a valid password, but the bad name must fail first.
    const res = await addUser(["x"], { stdin: "secret123\n" });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /Username must be/);
  });

  it("never echoes the password", async () => {
    const res = await addUser(["quiet", "-p", "do-not-print-me"]);
    assert.ok(!res.stdout.includes("do-not-print-me"));
    assert.ok(!res.stderr.includes("do-not-print-me"));
  });
});
