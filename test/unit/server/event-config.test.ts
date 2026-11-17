/** Unit tests for the device-event settings (poll interval safety floor, retention). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventConfigError, eventConfigFromEnv, isLoopbackUrl } from "../../../src/server/events/config.js";

const LOCAL = { THINQ_API_BASE_URL: "http://127.0.0.1:8090" };

describe("eventConfigFromEnv", () => {
  it("defaults to polling every 60 s and keeping events 30 days", () => {
    assert.deepEqual(eventConfigFromEnv({}), { pollIntervalMs: 60_000, retentionDays: 30 });
    assert.deepEqual(eventConfigFromEnv({ EVENT_POLL_INTERVAL_SECONDS: " ", EVENT_RETENTION_DAYS: "" }), {
      pollIntervalMs: 60_000,
      retentionDays: 30,
    });
  });

  it("reads custom values", () => {
    assert.deepEqual(eventConfigFromEnv({ EVENT_POLL_INTERVAL_SECONDS: "120", EVENT_RETENTION_DAYS: "7" }), {
      pollIntervalMs: 120_000,
      retentionDays: 7,
    });
    assert.equal(eventConfigFromEnv({ EVENT_POLL_INTERVAL_SECONDS: "15" }).pollIntervalMs, 15_000);
    assert.equal(eventConfigFromEnv({ EVENT_POLL_INTERVAL_SECONDS: "22.5" }).pollIntervalMs, 22_500);
  });

  it("refuses to poll the real ThinQ API faster than every 15 s", () => {
    for (const env of [
      { EVENT_POLL_INTERVAL_SECONDS: "14.9" },
      { EVENT_POLL_INTERVAL_SECONDS: "1" },
      { EVENT_POLL_INTERVAL_SECONDS: "0" },
      { EVENT_POLL_INTERVAL_SECONDS: "1", THINQ_API_BASE_URL: "https://api-aic.lgthinq.com" },
    ]) {
      assert.throws(() => eventConfigFromEnv(env), (err: unknown) => {
        assert.ok(err instanceof EventConfigError);
        assert.match(err.message, /only allowed against a local fake/);
        return true;
      });
    }
  });

  it("allows fast polling against a local fake ThinQ API", () => {
    assert.equal(eventConfigFromEnv({ ...LOCAL, EVENT_POLL_INTERVAL_SECONDS: "0.1" }).pollIntervalMs, 100);
    assert.equal(eventConfigFromEnv({ THINQ_API_BASE_URL: "http://localhost:9", EVENT_POLL_INTERVAL_SECONDS: "1" }).pollIntervalMs, 1000);
    assert.throws(() => eventConfigFromEnv({ ...LOCAL, EVENT_POLL_INTERVAL_SECONDS: "0.01" }), EventConfigError);
  });

  it("rejects intervals longer than a day", () => {
    assert.throws(() => eventConfigFromEnv({ EVENT_POLL_INTERVAL_SECONDS: "86401" }), EventConfigError);
  });

  it("rejects values that are not plain numbers instead of guessing", () => {
    for (const value of ["abc", "-60", "1e3", "0x10", "Infinity", "NaN", "60s", "6 0"]) {
      assert.throws(() => eventConfigFromEnv({ EVENT_POLL_INTERVAL_SECONDS: value }), EventConfigError, value);
      assert.throws(() => eventConfigFromEnv({ EVENT_RETENTION_DAYS: value }), EventConfigError, value);
    }
  });

  it("requires a whole number of retention days between 1 and 3650", () => {
    for (const value of ["0", "1.5", "3651"]) {
      assert.throws(() => eventConfigFromEnv({ EVENT_RETENTION_DAYS: value }), EventConfigError, value);
    }
    assert.equal(eventConfigFromEnv({ EVENT_RETENTION_DAYS: "3650" }).retentionDays, 3650);
    assert.equal(eventConfigFromEnv({ EVENT_RETENTION_DAYS: "1" }).retentionDays, 1);
  });
});

describe("isLoopbackUrl", () => {
  it("recognises this machine", () => {
    for (const url of ["http://127.0.0.1:8090", "http://localhost", "https://LOCALHOST:1/x", "http://[::1]:8090", "http://127.1.2.3"]) {
      assert.ok(isLoopbackUrl(url), url);
    }
  });

  it("does not mistake other hosts for loopback", () => {
    for (const url of [
      undefined,
      "",
      "not a url",
      "https://api-aic.lgthinq.com",
      "http://localhost.evil.example",
      "http://127.0.0.1.evil.example",
      "http://evil.example/?http://127.0.0.1",
      "http://127.0.0.1@evil.example",
      "http://10.0.0.1",
      "http://0.0.0.0",
      "ftp://127.0.0.1",
      "file:///etc/passwd",
    ]) {
      assert.ok(!isLoopbackUrl(url), String(url));
    }
  });
});
