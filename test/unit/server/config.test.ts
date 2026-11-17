import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConfigError,
  DEFAULT_DATABASE_PATH,
  cookieSecureFromEnv,
  databasePathFromEnv,
  loadConfig,
  logLevelFromEnv,
  portFromEnv,
  sessionTtlMs,
} from "../../../src/server/config.js";

const HOUR = 60 * 60 * 1000;

describe("loadConfig", () => {
  it("has working defaults for everything", () => {
    assert.deepEqual(loadConfig({}), {
      port: 3000,
      host: "127.0.0.1",
      logLevel: "info",
      databasePath: DEFAULT_DATABASE_PATH,
      sessionTtlMs: 7 * 24 * HOUR,
      cookieSecure: null,
      events: { pollIntervalMs: 60_000, retentionDays: 30 },
    });
  });

  it("reads every setting", () => {
    assert.deepEqual(
      loadConfig({
        PORT: "8080",
        HOST: "0.0.0.0",
        LOG_LEVEL: "WARN",
        DATABASE_PATH: "/var/lib/lg-home/db.sqlite",
        SESSION_TTL_HOURS: "12",
        COOKIE_SECURE: "true",
        EVENT_POLL_INTERVAL_SECONDS: "30",
        EVENT_RETENTION_DAYS: "7",
      }),
      {
        port: 8080,
        host: "0.0.0.0",
        logLevel: "warn",
        databasePath: "/var/lib/lg-home/db.sqlite",
        sessionTtlMs: 12 * HOUR,
        cookieSecure: true,
        events: { pollIntervalMs: 30_000, retentionDays: 7 },
      },
    );
  });

  it("reports every invalid setting at once", () => {
    const err = (() => {
      try {
        loadConfig({ PORT: "http", SESSION_TTL_HOURS: "forever", COOKIE_SECURE: "maybe", LOG_LEVEL: "loud", EVENT_POLL_INTERVAL_SECONDS: "1" });
      } catch (e) {
        return e;
      }
    })();
    assert.ok(err instanceof ConfigError, "a ConfigError");
    assert.equal(err.problems.length, 5);
    for (const name of ["PORT", "SESSION_TTL_HOURS", "COOKIE_SECURE", "LOG_LEVEL", "EVENT_POLL_INTERVAL_SECONDS"]) {
      assert.match(err.message, new RegExp(`- ${name} `), name);
    }
  });

  it("doesn't require ThinQ settings: device calls answer 503 until they are set", () => {
    assert.doesNotThrow(() => loadConfig({ THINQ_REGION: "nowhere" }));
  });
});

describe("settings", () => {
  it("PORT: a whole number from 0 to 65535", () => {
    assert.equal(portFromEnv({ PORT: " 0 " }), 0);
    assert.equal(portFromEnv({ PORT: "65535" }), 65535);
    for (const bad of ["-1", "65536", "3000.5", "1e3", "abc", "80 80"]) {
      assert.throws(() => portFromEnv({ PORT: bad }), /PORT must be a whole number/, bad);
    }
  });

  it("LOG_LEVEL: a known level, any case", () => {
    assert.equal(logLevelFromEnv({ LOG_LEVEL: "Debug" }), "debug");
    assert.equal(logLevelFromEnv({ LOG_LEVEL: "silent" }), "silent");
    assert.throws(() => logLevelFromEnv({ LOG_LEVEL: "verbose" }), /LOG_LEVEL must be one of/);
  });

  it("COOKIE_SECURE: true/1 or false/0 force the flag, unset detects HTTPS, anything else is an error", () => {
    assert.equal(cookieSecureFromEnv({}), null);
    assert.equal(cookieSecureFromEnv({ COOKIE_SECURE: " " }), null);
    for (const on of ["true", "1", "TRUE"]) assert.equal(cookieSecureFromEnv({ COOKIE_SECURE: on }), true, on);
    for (const off of ["false", "0", "False"]) assert.equal(cookieSecureFromEnv({ COOKIE_SECURE: off }), false, off);
    for (const bad of ["yes", "on", "2"]) {
      assert.throws(() => cookieSecureFromEnv({ COOKIE_SECURE: bad }), /COOKIE_SECURE must be true, 1, false or 0/, bad);
    }
  });

  it("DATABASE_PATH: used as given, default data/lg-home.db; other settings can't break it", () => {
    assert.equal(databasePathFromEnv({}), "data/lg-home.db");
    assert.equal(databasePathFromEnv({ DATABASE_PATH: "/tmp/x.db", SESSION_TTL_HOURS: "bad", PORT: "bad" }), "/tmp/x.db");
  });
});

describe("sessionTtlMs", () => {
  it("defaults to 7 days", () => {
    assert.equal(sessionTtlMs({}), 7 * 24 * HOUR);
    assert.equal(sessionTtlMs({ SESSION_TTL_HOURS: "" }), 7 * 24 * HOUR);
    assert.equal(sessionTtlMs({ SESSION_TTL_HOURS: "  " }), 7 * 24 * HOUR);
  });

  it("accepts positive hours, including fractions", () => {
    assert.equal(sessionTtlMs({ SESSION_TTL_HOURS: "1" }), HOUR);
    assert.equal(sessionTtlMs({ SESSION_TTL_HOURS: "0.5" }), HOUR / 2);
    assert.equal(sessionTtlMs({ SESSION_TTL_HOURS: " 24 " }), 24 * HOUR);
  });

  // Regression: "abc" used to yield NaN and make every login fail with a 500.
  for (const bad of ["abc", "0", "-1", "NaN", "Infinity", "1e9", "12h"]) {
    it(`rejects ${JSON.stringify(bad)} with a clear error`, () => {
      assert.throws(() => sessionTtlMs({ SESSION_TTL_HOURS: bad }), /SESSION_TTL_HOURS/);
    });
  }
});
