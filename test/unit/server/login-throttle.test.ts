import "../../helpers/test-db.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LoginThrottle } from "../../../src/server/login-throttle.js";

function throttle(options: ConstructorParameters<typeof LoginThrottle>[0] = {}) {
  let now = 1_000_000;
  const t = new LoginThrottle({ maxAttempts: 3, windowMs: 60_000, now: () => now, ...options });
  return { t, advance: (ms: number) => (now += ms) };
}

function fail(t: LoginThrottle, key: string, times: number) {
  for (let i = 0; i < times; i++) t.recordFailure(key);
}

describe("LoginThrottle", () => {
  it("has sensible production defaults", () => {
    const t = new LoginThrottle();
    assert.equal(t.maxAttempts, 10);
    assert.equal(t.windowMs, 15 * 60 * 1000);
    assert.ok(t.maxEntries >= 1000);
  });

  it("allows attempts below the limit and blocks at the limit", () => {
    const { t } = throttle();
    const key = t.key("1.2.3.4", "alice");
    assert.equal(t.isBlocked(key), false);
    fail(t, key, 2);
    assert.equal(t.isBlocked(key), false);
    fail(t, key, 1);
    assert.equal(t.isBlocked(key), true);
  });

  it("unblocks once the window since the first failure has passed", () => {
    const { t, advance } = throttle();
    const key = t.key("1.2.3.4", "alice");
    fail(t, key, 3);
    advance(59_999);
    assert.equal(t.isBlocked(key), true);
    advance(1);
    assert.equal(t.isBlocked(key), false);
    assert.equal(t.size, 0, "expired entry is dropped");
  });

  it("does not extend the window with further failures (fixed window)", () => {
    const { t, advance } = throttle();
    const key = t.key("ip", "alice");
    fail(t, key, 3);
    advance(30_000);
    fail(t, key, 5);
    advance(30_000);
    assert.equal(t.isBlocked(key), false);
  });

  it("starts a fresh count after the window expires", () => {
    const { t, advance } = throttle();
    const key = t.key("ip", "alice");
    fail(t, key, 2);
    advance(60_000);
    fail(t, key, 2);
    assert.equal(t.isBlocked(key), false);
    fail(t, key, 1);
    assert.equal(t.isBlocked(key), true);
  });

  it("reset clears the count (successful login)", () => {
    const { t } = throttle();
    const key = t.key("ip", "alice");
    fail(t, key, 3);
    t.reset(key);
    assert.equal(t.isBlocked(key), false);
    t.reset("never-seen"); // harmless
  });

  // Regression: the key used toLowerCase() but login trims too, so " alice" had
  // a fresh budget while still reaching the "alice" account.
  it("gives every spelling of the same account one shared budget", () => {
    const { t } = throttle();
    fail(t, t.key("ip", "alice"), 3);
    for (const variant of ["alice", "ALICE", " alice", "alice ", "\talice\n", "  AlIcE  "]) {
      assert.equal(t.isBlocked(t.key("ip", variant)), true, JSON.stringify(variant));
    }
  });

  it("tracks accounts and client IPs independently", () => {
    const { t } = throttle();
    fail(t, t.key("1.1.1.1", "alice"), 3);
    assert.equal(t.isBlocked(t.key("1.1.1.1", "bob")), false, "other account, same IP");
    assert.equal(t.isBlocked(t.key("2.2.2.2", "alice")), false, "same account, other IP");
  });

  it("an attacker on another IP cannot lock the real user out", () => {
    const { t } = throttle();
    fail(t, t.key("6.6.6.6", "alice"), 100);
    assert.equal(t.isBlocked(t.key("10.0.0.5", "alice")), false);
  });

  describe("memory bound", () => {
    it("never tracks more than maxEntries keys", () => {
      const { t } = throttle({ maxEntries: 100 });
      for (let i = 0; i < 1000; i++) t.recordFailure(t.key("ip", `user${i}`));
      assert.ok(t.size <= 100, `size ${t.size}`);
    });

    it("sweeps out all expired entries when full, not just one", () => {
      const { t, advance } = throttle({ maxEntries: 3 });
      for (const u of ["a", "b", "c"]) t.recordFailure(t.key("ip", u));
      advance(60_000); // all three expire
      t.recordFailure(t.key("ip", "d"));
      assert.equal(t.size, 1);
    });

    it("evicts the oldest entry when all are live", () => {
      const { t } = throttle({ maxEntries: 2 });
      t.recordFailure(t.key("ip", "first"));
      t.recordFailure(t.key("ip", "second"));
      t.recordFailure(t.key("ip", "third"));
      assert.equal(t.size, 2);
      fail(t, t.key("ip", "second"), 2);
      assert.equal(t.isBlocked(t.key("ip", "second")), true, "second survived eviction");
    });
  });
});
