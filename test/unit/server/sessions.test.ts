import { db, resetDb, schema } from "../../helpers/test-db.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  DEFAULT_SESSION_TTL_MS,
  createSession,
  deleteExpiredSessions,
  deleteSession,
  deleteUserSessions,
  getSessionUser,
} from "../../../src/server/auth.js";
import { provisionUser } from "../../../src/server/users.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function userId(username: string): number {
  return db.select().from(schema.users).where(eq(schema.users.username, username)).get()!.id;
}

/** Insert a session row directly, e.g. one that is already expired. */
function insertSession(token: string, uid: number, expiresAt: Date): void {
  db.insert(schema.sessions).values({ id: sha256(token), userId: uid, createdAt: new Date(), expiresAt }).run();
}

describe("sessions", () => {
  let alice: number;
  let bob: number;

  beforeEach(async () => {
    resetDb();
    await provisionUser({ username: "alice", password: "secret123" });
    await provisionUser({ username: "bob", password: "secret456" });
    alice = userId("alice");
    bob = userId("bob");
  });

  describe("createSession", () => {
    it("returns a high-entropy url-safe token", () => {
      const { token } = createSession(alice);
      assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
    });

    it("issues a different token every time", () => {
      const tokens = new Set(Array.from({ length: 50 }, () => createSession(alice).token));
      assert.equal(tokens.size, 50);
    });

    it("stores only a SHA-256 of the token, never the token itself", () => {
      const { token } = createSession(alice);
      const rows = db.select().from(schema.sessions).all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, sha256(token));
      assert.ok(!rows.some((r) => r.id === token));
    });

    it("expires after 7 days by default", () => {
      const before = Date.now();
      const { expiresAt } = createSession(alice);
      const delta = expiresAt.getTime() - before;
      assert.equal(DEFAULT_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
      assert.ok(delta >= DEFAULT_SESSION_TTL_MS - 1000 && delta <= DEFAULT_SESSION_TTL_MS + 1000);
    });

    it("expires after the lifetime it is given (SESSION_TTL_HOURS)", () => {
      const before = Date.now();
      const { token, expiresAt } = createSession(alice, 60 * 60 * 1000);
      const delta = expiresAt.getTime() - before;
      assert.ok(delta >= 3_599_000 && delta <= 3_601_000, `got ${delta} ms`);
      const stored = db.select().from(schema.sessions).where(eq(schema.sessions.id, sha256(token))).get()!;
      assert.equal(stored.expiresAt.getTime(), expiresAt.getTime());
    });

    it("prunes expired sessions as a side effect", () => {
      insertSession("old", alice, new Date(Date.now() - 1000));
      createSession(bob);
      assert.equal(db.select().from(schema.sessions).all().length, 1);
    });
  });

  describe("getSessionUser", () => {
    it("resolves a valid token to its user", () => {
      const { token } = createSession(alice);
      assert.deepEqual(getSessionUser(token), { id: alice, username: "alice" });
    });

    it("returns null for missing, empty, unknown or malformed tokens", () => {
      createSession(alice);
      for (const token of [undefined, "", "nope", "x".repeat(10_000), "' OR 1=1 --", "\u0000"]) {
        assert.equal(getSessionUser(token), null, JSON.stringify(token)?.slice(0, 20));
      }
    });

    it("rejects the stored hash used as a token (a DB leak must not yield sessions)", () => {
      const { token } = createSession(alice);
      assert.equal(getSessionUser(sha256(token)), null);
    });

    it("rejects expired sessions, right at the boundary too", () => {
      insertSession("expired", alice, new Date(Date.now() - 1));
      insertSession("now", alice, new Date(Date.now()));
      assert.equal(getSessionUser("expired"), null);
      assert.equal(getSessionUser("now"), null);
    });

    it("accepts a session that is just about to expire", () => {
      insertSession("soon", alice, new Date(Date.now() + 5_000));
      assert.equal(getSessionUser("soon")?.username, "alice");
    });

    it("never returns another user's identity", () => {
      const a = createSession(alice).token;
      const b = createSession(bob).token;
      assert.equal(getSessionUser(a)?.username, "alice");
      assert.equal(getSessionUser(b)?.username, "bob");
    });
  });

  describe("deleting", () => {
    it("deleteSession ends only that session", () => {
      const one = createSession(alice).token;
      const two = createSession(alice).token;
      deleteSession(one);
      assert.equal(getSessionUser(one), null);
      assert.equal(getSessionUser(two)?.username, "alice");
    });

    it("deleteSession ignores missing and unknown tokens", () => {
      const token = createSession(alice).token;
      deleteSession(undefined);
      deleteSession("");
      deleteSession("unknown");
      assert.equal(getSessionUser(token)?.username, "alice");
    });

    it("deleteUserSessions signs one user out everywhere, leaving others alone", () => {
      const a1 = createSession(alice).token;
      const a2 = createSession(alice).token;
      const b = createSession(bob).token;
      deleteUserSessions(alice);
      assert.equal(getSessionUser(a1), null);
      assert.equal(getSessionUser(a2), null);
      assert.equal(getSessionUser(b)?.username, "bob");
    });

    it("deleteExpiredSessions keeps live sessions", () => {
      insertSession("dead", alice, new Date(Date.now() - 60_000));
      const live = createSession(bob).token;
      insertSession("dead2", bob, new Date(Date.now() - 1));
      deleteExpiredSessions();
      const ids = db.select().from(schema.sessions).all().map((r) => r.id);
      assert.deepEqual(ids, [sha256(live)]);
    });

    it("deleting a user cascades to their sessions", () => {
      const token = createSession(alice).token;
      db.delete(schema.users).where(eq(schema.users.id, alice)).run();
      assert.equal(getSessionUser(token), null);
      assert.equal(db.select().from(schema.sessions).all().length, 0);
    });
  });
});
