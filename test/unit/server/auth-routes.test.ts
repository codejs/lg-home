import { db, resetDb, schema } from "../../helpers/test-db.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { LoginThrottle } from "../../../src/server/login-throttle.js";
import { as, buildTestApp, cookiePair, createUser, login } from "../../helpers/app.js";

const LOGIN = { method: "POST", url: "/api/auth/login" } as const;

describe("auth routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetDb();
    await createUser("alice", "secret123");
    ({ app } = await buildTestApp());
  });
  afterEach(() => app.close());

  describe("POST /api/auth/login", () => {
    it("logs in, returning only the public user fields", async () => {
      const res = await app.inject({ ...LOGIN, payload: { username: "alice", password: "secret123" } });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(Object.keys(body.user).sort(), ["id", "username"]);
      assert.ok(!res.body.includes("scrypt"), "no password hash in the response");
      assert.ok(!res.body.includes("secret123"));
    });

    it("sets a hardened session cookie", async () => {
      const res = await app.inject({ ...LOGIN, payload: { username: "alice", password: "secret123" } });
      const header = String(res.headers["set-cookie"]);
      assert.match(header, /^lg_home_session=[A-Za-z0-9_-]{43}; /);
      assert.match(header, /HttpOnly/);
      assert.match(header, /SameSite=Lax/);
      assert.match(header, /Path=\//);
      assert.doesNotMatch(header, /Secure/, "plain HTTP in tests");
    });

    it("does not trust a spoofed X-Forwarded-Proto for the Secure flag", async () => {
      // trustProxy is off: behind a real proxy, set COOKIE_SECURE=true instead.
      const res = await app.inject({
        ...LOGIN,
        headers: { "x-forwarded-proto": "https" },
        payload: { username: "alice", password: "secret123" },
      });
      assert.doesNotMatch(String(res.headers["set-cookie"]), /Secure/);
    });

    it("accepts any spelling of the username that normalises to the account", async () => {
      for (const username of ["ALICE", "  alice  ", "Alice"]) {
        const res = await app.inject({ ...LOGIN, payload: { username, password: "secret123" } });
        assert.equal(res.statusCode, 200, username);
      }
    });

    it("gives the same answer for a wrong password and an unknown user (no enumeration)", async () => {
      const wrongPassword = await app.inject({ ...LOGIN, payload: { username: "alice", password: "nope-nope" } });
      const unknownUser = await app.inject({ ...LOGIN, payload: { username: "mallory", password: "nope-nope" } });
      assert.equal(wrongPassword.statusCode, 401);
      assert.equal(unknownUser.statusCode, 401);
      assert.equal(wrongPassword.body, unknownUser.body);
      assert.deepEqual(wrongPassword.json(), { error: "Invalid username or password" });
      assert.equal(wrongPassword.headers["set-cookie"], undefined);
    });

    describe("input validation", () => {
      const invalid: [string, unknown][] = [
        ["missing body", undefined],
        ["empty object", {}],
        ["missing password", { username: "alice" }],
        ["missing username", { password: "secret123" }],
        ["empty username", { username: "", password: "secret123" }],
        ["empty password", { username: "alice", password: "" }],
        ["username too long", { username: "a".repeat(129), password: "secret123" }],
        ["password too long", { username: "alice", password: "x".repeat(1025) }],
        ["NoSQL-style operator object", { username: { $ne: null }, password: { $ne: null } }],
        ["array body", [{ username: "alice", password: "secret123" }]],
        ["null fields", { username: null, password: null }],
      ];
      for (const [name, payload] of invalid) {
        it(`rejects ${name} with 400`, async () => {
          const res = await app.inject({
            ...LOGIN,
            headers: { "content-type": "application/json" },
            payload: payload === undefined ? "" : JSON.stringify(payload),
          });
          assert.equal(res.statusCode, 400, res.body);
          assert.equal(res.headers["set-cookie"], undefined);
        });
      }

      it("rejects malformed JSON with 400, not 500", async () => {
        const res = await app.inject({ ...LOGIN, headers: { "content-type": "application/json" }, payload: "{bad json" });
        assert.equal(res.statusCode, 400);
      });

      it("rejects form posts (415): cross-site HTML forms can't send JSON", async () => {
        const res = await app.inject({
          ...LOGIN,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: "username=alice&password=secret123",
        });
        assert.equal(res.statusCode, 415);
      });

      it("does not treat a text/plain body as JSON (form enctype=text/plain CSRF trick)", async () => {
        const res = await app.inject({
          ...LOGIN,
          headers: { "content-type": "text/plain" },
          payload: JSON.stringify({ username: "alice", password: "secret123" }),
        });
        assert.equal(res.statusCode, 400);
        assert.equal(res.headers["set-cookie"], undefined);
      });

      it("ignores unknown extra fields rather than acting on them", async () => {
        const res = await app.inject({ ...LOGIN, payload: { username: "alice", password: "secret123", isAdmin: true } });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(Object.keys(res.json().user).sort(), ["id", "username"]);
      });

      it("treats SQL metacharacters as plain data", async () => {
        for (const username of ["alice' --", "' OR '1'='1", "alice'; DROP TABLE users; --"]) {
          const res = await app.inject({ ...LOGIN, payload: { username, password: "' OR '1'='1" } });
          assert.equal(res.statusCode, 401);
        }
        assert.equal(db.select().from(schema.users).all().length, 1, "users table intact");
      });
    });

    it("rotates the session on login (session fixation)", async () => {
      const planted = await login(app);
      const res = await as(app, planted, { ...LOGIN, payload: { username: "alice", password: "secret123" } });
      const fresh = cookiePair(res);
      assert.notEqual(fresh, planted);
      assert.equal((await as(app, planted, { method: "GET", url: "/api/auth/me" })).statusCode, 401, "old session dead");
      assert.equal((await as(app, fresh, { method: "GET", url: "/api/auth/me" })).statusCode, 200);
    });

    it("allows independent concurrent sessions (two browsers)", async () => {
      const laptop = await login(app);
      const phone = await login(app);
      assert.notEqual(laptop, phone);
      for (const cookie of [laptop, phone]) {
        assert.equal((await as(app, cookie, { method: "GET", url: "/api/auth/me" })).statusCode, 200);
      }
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns the signed-in user", async () => {
      const cookie = await login(app);
      const res = await as(app, cookie, { method: "GET", url: "/api/auth/me" });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().user.username, "alice");
    });

    const badCookies: [string, string][] = [
      ["no cookie", ""],
      ["garbage token", "lg_home_session=garbage"],
      ["empty token", "lg_home_session="],
      ["malformed escape", "lg_home_session=%E0%A4%A"],
      ["wrong cookie name", "session=abc"],
      ["huge token", `lg_home_session=${"a".repeat(4000)}`],
    ];
    for (const [name, cookie] of badCookies) {
      it(`401 with ${name}`, async () => {
        const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: cookie ? { cookie } : {} });
        assert.equal(res.statusCode, 401);
        assert.deepEqual(res.json(), { error: "Authentication required" });
      });
    }

    it("401 once the session has expired", async () => {
      const cookie = await login(app);
      db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) }).run();
      assert.equal((await as(app, cookie, { method: "GET", url: "/api/auth/me" })).statusCode, 401);
    });

    it("401 after the user is deleted", async () => {
      const cookie = await login(app);
      db.delete(schema.users).where(eq(schema.users.username, "alice")).run();
      assert.equal((await as(app, cookie, { method: "GET", url: "/api/auth/me" })).statusCode, 401);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("ends the session and clears the cookie", async () => {
      const cookie = await login(app);
      const res = await as(app, cookie, { method: "POST", url: "/api/auth/logout" });
      assert.equal(res.statusCode, 200);
      assert.match(String(res.headers["set-cookie"]), /^lg_home_session=; .*Max-Age=0/);
      assert.equal((await as(app, cookie, { method: "GET", url: "/api/auth/me" })).statusCode, 401);
      assert.equal(db.select().from(schema.sessions).all().length, 0);
    });

    it("only ends the caller's own session", async () => {
      const laptop = await login(app);
      const phone = await login(app);
      await as(app, laptop, { method: "POST", url: "/api/auth/logout" });
      assert.equal((await as(app, phone, { method: "GET", url: "/api/auth/me" })).statusCode, 200);
    });

    it("is safe without a session, and repeatable", async () => {
      assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout" })).statusCode, 200);
      const cookie = await login(app);
      await as(app, cookie, { method: "POST", url: "/api/auth/logout" });
      assert.equal((await as(app, cookie, { method: "POST", url: "/api/auth/logout" })).statusCode, 200);
    });
  });
});

describe("login throttling over HTTP", () => {
  let app: FastifyInstance;
  let now = 0;

  const attempt = (username: string, password: string, remoteAddress = "10.0.0.1") =>
    app.inject({ ...LOGIN, remoteAddress, payload: { username, password } });

  beforeEach(async () => {
    resetDb();
    await createUser("alice", "secret123");
    await createUser("bob", "secret456");
    now = 0;
    ({ app } = await buildTestApp({ throttle: new LoginThrottle({ maxAttempts: 3, windowMs: 60_000, now: () => now }) }));
  });
  afterEach(() => app.close());

  it("answers 429 after too many failures, even for the right password", async () => {
    for (let i = 0; i < 3; i++) assert.equal((await attempt("alice", `guess-${i}`)).statusCode, 401);
    const blocked = await attempt("alice", "secret123");
    assert.equal(blocked.statusCode, 429);
    assert.match(blocked.json().error, /Too many failed attempts/);
    assert.equal(blocked.headers["set-cookie"], undefined);
  });

  // Regression: " alice" / "alice  " had their own budget but logged into "alice".
  it("cannot be bypassed with whitespace or case variants of the username", async () => {
    for (let i = 0; i < 3; i++) await attempt("alice", `guess-${i}`);
    for (const variant of [" alice", "alice ", "ALICE", "\talice", "  Alice  "]) {
      assert.equal((await attempt(variant, "secret123")).statusCode, 429, JSON.stringify(variant));
    }
  });

  it("blocks unknown usernames too (no difference that reveals which exist)", async () => {
    for (let i = 0; i < 3; i++) assert.equal((await attempt("ghost", `g${i}`)).statusCode, 401);
    assert.equal((await attempt("ghost", "g")).statusCode, 429);
  });

  it("does not lock out other accounts or other clients", async () => {
    for (let i = 0; i < 3; i++) await attempt("alice", `guess-${i}`, "6.6.6.6");
    assert.equal((await attempt("bob", "secret456", "6.6.6.6")).statusCode, 200, "other account");
    assert.equal((await attempt("alice", "secret123", "10.0.0.9")).statusCode, 200, "other IP");
  });

  it("lifts the block when the window has passed", async () => {
    for (let i = 0; i < 3; i++) await attempt("alice", `guess-${i}`);
    now += 60_000;
    assert.equal((await attempt("alice", "secret123")).statusCode, 200);
  });

  it("a successful login resets the failure count", async () => {
    await attempt("alice", "guess-1");
    await attempt("alice", "guess-2");
    assert.equal((await attempt("alice", "secret123")).statusCode, 200);
    await attempt("alice", "guess-3");
    await attempt("alice", "guess-4");
    assert.equal((await attempt("alice", "secret123")).statusCode, 200, "count restarted after success");
  });

  it("malformed requests don't count as attempts", async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({ ...LOGIN, remoteAddress: "10.0.0.1", payload: { username: "alice" } });
    }
    assert.equal((await attempt("alice", "secret123")).statusCode, 200);
  });

  it("each app instance has its own throttle state", async () => {
    for (let i = 0; i < 3; i++) await attempt("alice", `guess-${i}`);
    const { app: other } = await buildTestApp();
    try {
      const res = await other.inject({ ...LOGIN, remoteAddress: "10.0.0.1", payload: { username: "alice", password: "secret123" } });
      assert.equal(res.statusCode, 200);
    } finally {
      await other.close();
    }
  });
});
