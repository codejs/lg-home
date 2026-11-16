import { resetDb } from "../../helpers/test-db.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { authenticate, hashPassword, normalizeUsername, verifyPassword } from "../../../src/server/auth.js";
import { provisionUser } from "../../../src/server/users.js";

describe("hashPassword", () => {
  it("produces a self-describing scrypt digest", async () => {
    const hash = await hashPassword("secret123");
    const [scheme, n, r, p, salt, digest] = hash.split("$");
    assert.equal(scheme, "scrypt");
    assert.deepEqual([n, r, p], ["16384", "8", "1"]);
    assert.equal(Buffer.from(salt, "base64").length, 16);
    assert.equal(Buffer.from(digest, "base64").length, 64);
  });

  it("never contains the password", async () => {
    const hash = await hashPassword("secret123");
    assert.ok(!hash.includes("secret123"));
    assert.ok(!hash.includes(Buffer.from("secret123").toString("base64")));
  });

  it("salts every hash, so equal passwords give different digests", async () => {
    const a = await hashPassword("secret123");
    const b = await hashPassword("secret123");
    assert.notEqual(a, b);
    assert.notEqual(a.split("$")[4], b.split("$")[4], "salts differ");
  });
});

describe("verifyPassword", () => {
  it("accepts the right password and rejects others", async () => {
    const hash = await hashPassword("secret123");
    assert.equal(await verifyPassword("secret123", hash), true);
    assert.equal(await verifyPassword("secret124", hash), false);
    assert.equal(await verifyPassword("Secret123", hash), false, "case sensitive");
    assert.equal(await verifyPassword("secret123 ", hash), false, "trailing space matters");
    assert.equal(await verifyPassword("", hash), false);
  });

  it("handles unicode passwords, treating canonically equivalent forms as equal (NFKC)", async () => {
    const composed = "p\u00e4ssw\u00f6rd!"; // ä, ö as single code points
    const decomposed = "pa\u0308ssw\u006f\u0308rd!"; // a + combining diaeresis
    const hash = await hashPassword(composed);
    assert.equal(await verifyPassword(composed, hash), true);
    assert.equal(await verifyPassword(decomposed, hash), true);
    assert.equal(await verifyPassword("passwordx", hash), false);

    const emoji = await hashPassword("🔐 correct horse 🐴");
    assert.equal(await verifyPassword("🔐 correct horse 🐴", emoji), true);
  });

  it("accepts the longest allowed password", async () => {
    const long = "x".repeat(1024);
    const hash = await hashPassword(long);
    assert.equal(await verifyPassword(long, hash), true);
    assert.equal(await verifyPassword("x".repeat(1023), hash), false);
  });

  it("rejects prefixes, extensions and embedded NULs", async () => {
    const hash = await hashPassword("secret123");
    assert.equal(await verifyPassword("secret12", hash), false);
    assert.equal(await verifyPassword("secret1234", hash), false);
    assert.equal(await verifyPassword("secret123\u0000abc", hash), false);
    assert.equal(await verifyPassword("\u0000secret123", hash), false);
  });

  it("documents the HMAC zero-padding property: trailing NULs are equivalent", async () => {
    // scrypt runs PBKDF2-HMAC-SHA256, which zero-pads short keys, so "pw" and
    // "pw\0" are the same key. Harmless (it needs the password), but it is why
    // validatePassword rejects control characters. If this starts failing, the
    // KDF changed: re-check that assumption.
    const hash = await hashPassword("secret123");
    assert.equal(await verifyPassword("secret123\u0000", hash), true);
  });

  describe("never matches a malformed or tampered digest", () => {
    const salt = Buffer.from("0123456789abcdef").toString("base64");
    const digest64 = Buffer.alloc(64, 7).toString("base64");
    const cases: [string, string][] = [
      ["empty string", ""],
      ["plaintext", "secret123"],
      ["wrong scheme", `bcrypt$16384$8$1$${salt}$${digest64}`],
      ["missing fields", `scrypt$16384$8$1$${salt}`],
      ["extra fields", `scrypt$16384$8$1$${salt}$${digest64}$x`],
      // Regression: an empty digest made scrypt compare 0 bytes to 0 bytes -> any password matched.
      ["empty digest", `scrypt$16384$8$1$${salt}$`],
      ["digest that decodes to nothing", `scrypt$16384$8$1$${salt}$!!`],
      ["too-short digest", `scrypt$16384$8$1$${salt}$${Buffer.alloc(4).toString("base64")}`],
      ["empty salt", `scrypt$16384$8$1$$${digest64}`],
      ["N not a power of two", `scrypt$3$8$1$${salt}$${digest64}`],
      ["N not a number", `scrypt$abc$8$1$${salt}$${digest64}`],
      ["N too small", `scrypt$2$8$1$${salt}$${digest64}`],
      ["N absurdly large (DoS)", `scrypt$${2 ** 30}$8$1$${salt}$${digest64}`],
      ["r = 0", `scrypt$16384$0$1$${salt}$${digest64}`],
      ["r huge (DoS)", `scrypt$16384$9999$1$${salt}$${digest64}`],
      ["p = 0", `scrypt$16384$8$0$${salt}$${digest64}`],
      ["p fractional", `scrypt$16384$8$1.5$${salt}$${digest64}`],
      ["negative N", `scrypt$-16384$8$1$${salt}$${digest64}`],
    ];
    for (const [name, stored] of cases) {
      it(name, async () => {
        for (const password of ["", "anything", "secret123"]) {
          assert.equal(await verifyPassword(password, stored), false);
        }
      });
    }
  });

  // maxmem bounds memory (128·r·N + 128·r·p bytes), but p=2000 still fits in
  // ~18 MB while doing 2000x the work. A tampered row like that must be refused
  // up front, not computed.
  it("refuses a huge parallelisation factor quickly (CPU DoS)", async () => {
    const salt = Buffer.from("0123456789abcdef").toString("base64");
    const stored = `scrypt$16384$8$2000$${salt}$${Buffer.alloc(64, 7).toString("base64")}`;
    const started = performance.now();
    assert.equal(await verifyPassword("secret123", stored), false);
    assert.ok(performance.now() - started < 1000, "took too long: parameters were not bounded");
  });

  it("refuses a matching digest made with downgraded parameters (N below policy)", async () => {
    const { scryptSync } = await import("node:crypto");
    const salt = Buffer.from("0123456789abcdef");
    const weak = scryptSync("secret123", salt, 64, { N: 16, r: 1, p: 1 });
    const stored = `scrypt$16$1$1$${salt.toString("base64")}$${weak.toString("base64")}`;
    assert.equal(await verifyPassword("secret123", stored), false);
  });

  it("rejects a digest for a different password even with valid params", async () => {
    const other = await hashPassword("another-password");
    assert.equal(await verifyPassword("secret123", other), false);
  });
});

describe("normalizeUsername", () => {
  it("trims and lower-cases", () => {
    assert.equal(normalizeUsername("  Alice "), "alice");
    assert.equal(normalizeUsername("ALICE"), "alice");
    assert.equal(normalizeUsername("\talice\n"), "alice");
    assert.equal(normalizeUsername("alice"), "alice");
  });
});

describe("authenticate", () => {
  beforeEach(async () => {
    resetDb();
    await provisionUser({ username: "alice", password: "secret123" });
  });

  it("returns only id and username on success", async () => {
    const user = await authenticate("alice", "secret123");
    assert.ok(user);
    assert.deepEqual(Object.keys(user).sort(), ["id", "username"]);
    assert.equal(user.username, "alice");
  });

  it("normalises the username like the CLI does", async () => {
    assert.ok(await authenticate("ALICE", "secret123"));
    assert.ok(await authenticate("  alice  ", "secret123"));
  });

  it("returns null for a wrong password or an unknown user", async () => {
    assert.equal(await authenticate("alice", "wrong-password"), null);
    assert.equal(await authenticate("bob", "secret123"), null);
    assert.equal(await authenticate("", ""), null);
  });

  it("is not fooled by SQL-injection style input", async () => {
    for (const username of ["alice' --", "' OR '1'='1", "alice\" OR 1=1 --", "%", "_lice", "*"]) {
      assert.equal(await authenticate(username, "secret123"), null, username);
      assert.equal(await authenticate("alice", `' OR '1'='1`), null);
    }
  });

  it("still spends a hash on unknown users (no fast path that reveals which usernames exist)", async () => {
    // A bare DB miss takes well under a millisecond; scrypt takes tens.
    const started = performance.now();
    await authenticate("nobody-here", "secret123");
    const unknownMs = performance.now() - started;
    assert.ok(unknownMs > 5, `unknown-user check took only ${unknownMs.toFixed(2)} ms`);
  });
});
