import { db, resetDb, schema } from "../../helpers/test-db.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { authenticate, createSession, getSessionUser } from "../../../src/server/auth.js";
import { UserInputError, provisionUser, validatePassword, validateUsername } from "../../../src/server/users.js";

const userRow = (username: string) => db.select().from(schema.users).where(eq(schema.users.username, username)).get();

describe("validateUsername", () => {
  it("normalises to trimmed lower case", () => {
    assert.equal(validateUsername("  Alice "), "alice");
    assert.equal(validateUsername("Bob.Smith@Home"), "bob.smith@home");
  });

  it("accepts letters, digits and . _ @ - within 3..64 characters", () => {
    for (const ok of ["abc", "a.b", "a_b", "a-b", "a@b.c", "123", "x".repeat(64)]) {
      assert.equal(validateUsername(ok), ok);
    }
  });

  const bad: [string, string][] = [
    ["too short", "ab"],
    ["too long", "x".repeat(65)],
    ["empty", ""],
    ["only spaces", "   "],
    ["inner space", "al ice"],
    ["SQL injection", "alice' OR '1'='1"],
    ["path traversal", "../../etc/passwd"],
    ["HTML", "<script>alert(1)</script>"],
    ["NUL byte", "alice\u0000"],
    ["newline (log injection)", "alice\nadmin logged in"],
    ["non-ASCII look-alike", "аlice"], // Cyrillic 'а'
    ["emoji", "al😀ce"],
    ["pipe", "a|b"],
  ];
  for (const [name, value] of bad) {
    it(`rejects ${name}`, () => assert.throws(() => validateUsername(value), UserInputError));
  }
});

describe("validatePassword", () => {
  it("enforces 8..1024 characters", () => {
    assert.throws(() => validatePassword("1234567"), /at least 8/);
    validatePassword("12345678");
    validatePassword("x".repeat(1024));
    // The login endpoint caps at 1024, so a longer one could never be used.
    assert.throws(() => validatePassword("x".repeat(1025)), /at most 1024/);
  });

  it("allows spaces, symbols and unicode", () => {
    validatePassword("correct horse battery staple");
    validatePassword("p@$$w0rd!#%^&*()");
    validatePassword("пароль-密码-🔐🔐");
    validatePassword("        "); // eight spaces: weak but legal; policy is length-based
  });

  it("rejects control characters", () => {
    for (const c of ["\u0000", "\n", "\r", "\t", "\u001b", "\u007f"]) {
      assert.throws(() => validatePassword(`secret123${c}`), /control characters/, JSON.stringify(c));
    }
  });
});

describe("provisionUser", () => {
  beforeEach(resetDb);

  it("creates a user with a hashed password that can log in", async () => {
    const result = await provisionUser({ username: "Alice", password: "secret123" });
    assert.deepEqual(result, { username: "alice", created: true });
    const row = userRow("alice")!;
    assert.match(row.passwordHash, /^scrypt\$/);
    assert.ok(!row.passwordHash.includes("secret123"));
    assert.equal(row.createdAt.getTime(), row.updatedAt.getTime());
    assert.ok(await authenticate("alice", "secret123"));
  });

  it("refuses to overwrite an existing user without force", async () => {
    await provisionUser({ username: "alice", password: "secret123" });
    const before = userRow("alice")!.passwordHash;
    await assert.rejects(provisionUser({ username: "ALICE", password: "other-password" }), /already exists.*--force/);
    assert.equal(userRow("alice")!.passwordHash, before, "password unchanged");
  });

  it("with force, replaces the password and signs the user out everywhere", async () => {
    await provisionUser({ username: "alice", password: "secret123" });
    await provisionUser({ username: "bob", password: "secret456" });
    const aliceSession = createSession(userRow("alice")!.id).token;
    const bobSession = createSession(userRow("bob")!.id).token;

    const result = await provisionUser({ username: "alice", password: "new-password", force: true });
    assert.deepEqual(result, { username: "alice", created: false });
    assert.equal(await authenticate("alice", "secret123"), null, "old password no longer works");
    assert.ok(await authenticate("alice", "new-password"));
    assert.equal(getSessionUser(aliceSession), null, "alice's sessions revoked");
    assert.equal(getSessionUser(bobSession)?.username, "bob", "bob untouched");

    const row = userRow("alice")!;
    assert.ok(row.updatedAt.getTime() >= row.createdAt.getTime());
    assert.equal(db.select().from(schema.users).all().length, 2, "no duplicate row");
  });

  it("force on a new user simply creates it", async () => {
    assert.deepEqual(await provisionUser({ username: "carol", password: "secret789", force: true }), {
      username: "carol",
      created: true,
    });
  });

  it("validates before writing anything", async () => {
    await assert.rejects(provisionUser({ username: "x", password: "secret123" }), UserInputError);
    await assert.rejects(provisionUser({ username: "dave", password: "short" }), UserInputError);
    assert.equal(db.select().from(schema.users).all().length, 0);
  });

  it("a failed force-update with a bad password keeps the old password and sessions", async () => {
    await provisionUser({ username: "alice", password: "secret123" });
    const session = createSession(userRow("alice")!.id).token;
    await assert.rejects(provisionUser({ username: "alice", password: "short", force: true }), UserInputError);
    assert.ok(await authenticate("alice", "secret123"));
    assert.equal(getSessionUser(session)?.username, "alice");
  });
});
