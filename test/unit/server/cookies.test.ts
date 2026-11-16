import "../../helpers/test-db.js";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { FastifyRequest } from "fastify";
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  isSecureRequest,
  parseCookies,
  sessionCookie,
  sessionTokenOf,
} from "../../../src/server/auth.js";

const fakeRequest = (init: { cookie?: string; protocol?: "http" | "https" }) =>
  ({ headers: { cookie: init.cookie }, protocol: init.protocol ?? "http" }) as unknown as FastifyRequest;

/** Split a Set-Cookie header into a map of attributes (lower-cased names). */
function attributes(header: string): Map<string, string> {
  const [, ...attrs] = header.split("; ");
  return new Map(attrs.map((a) => [a.split("=")[0].toLowerCase(), a.split("=")[1] ?? ""]));
}

describe("parseCookies", () => {
  it("returns an empty map for a missing or empty header", () => {
    assert.deepEqual({ ...parseCookies(undefined) }, {});
    assert.deepEqual({ ...parseCookies("") }, {});
    assert.deepEqual({ ...parseCookies(";;  ;") }, {});
  });

  it("parses several cookies and trims whitespace", () => {
    assert.deepEqual({ ...parseCookies("a=1; b=2;c=3 ;  d = 4") }, { a: "1", b: "2", c: "3", d: "4" });
  });

  it("keeps '=' inside values", () => {
    assert.deepEqual({ ...parseCookies("t=abc==; q=a=b") }, { t: "abc==", q: "a=b" });
  });

  it("decodes percent-encoding", () => {
    assert.equal(parseCookies("x=hello%20world")["x"], "hello%20world".replace("%20", " "));
  });

  // Regression: a malformed escape made decodeURIComponent throw -> 500 on every request.
  it("does not throw on malformed percent-encoding", () => {
    assert.equal(parseCookies(`${SESSION_COOKIE}=%E0%A4%A`)[SESSION_COOKIE], "%E0%A4%A");
    assert.equal(parseCookies("x=%")["x"], "%");
    assert.equal(parseCookies("x=%zz; y=1")["y"], "1");
  });

  it("uses the first occurrence of a duplicated name", () => {
    assert.equal(parseCookies(`${SESSION_COOKIE}=first; ${SESSION_COOKIE}=second`)[SESSION_COOKIE], "first");
  });

  it("skips parts without a name or without '='", () => {
    assert.deepEqual({ ...parseCookies("=nameless; flag; a=1") }, { a: "1" });
  });

  it("is safe against prototype pollution via cookie names", () => {
    const cookies = parseCookies("__proto__=polluted; constructor=x; toString=y");
    assert.equal(cookies["__proto__"], "polluted");
    assert.equal(cookies["constructor"], "x");
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  });

  it("allows empty values", () => {
    assert.equal(parseCookies("a=")["a"], "");
  });
});

describe("sessionTokenOf", () => {
  it("extracts the session cookie among others", () => {
    assert.equal(sessionTokenOf(fakeRequest({ cookie: `theme=dark; ${SESSION_COOKIE}=tok123; x=y` })), "tok123");
  });

  it("is undefined without the cookie", () => {
    assert.equal(sessionTokenOf(fakeRequest({})), undefined);
    assert.equal(sessionTokenOf(fakeRequest({ cookie: "other=1" })), undefined);
    assert.equal(sessionTokenOf(fakeRequest({ cookie: `${SESSION_COOKIE}x=tok` })), undefined, "no prefix matching");
  });
});

describe("sessionCookie", () => {
  it("is HttpOnly, SameSite=Lax and scoped to the whole site", () => {
    const header = sessionCookie("tok", new Date(Date.now() + 3600_000), false);
    assert.ok(header.startsWith(`${SESSION_COOKIE}=tok; `));
    const attrs = attributes(header);
    assert.ok(attrs.has("httponly"), "not readable from JavaScript (XSS)");
    assert.equal(attrs.get("samesite"), "Lax", "not sent on cross-site POSTs (CSRF)");
    assert.equal(attrs.get("path"), "/");
    assert.ok(!attrs.has("domain"), "host-only cookie");
    assert.ok(!attrs.has("secure"));
  });

  it("sets Max-Age to the remaining lifetime in seconds", () => {
    const maxAge = Number(attributes(sessionCookie("t", new Date(Date.now() + 3600_000), false)).get("max-age"));
    assert.ok(maxAge >= 3599 && maxAge <= 3600, String(maxAge));
  });

  it("never emits a negative Max-Age", () => {
    assert.equal(attributes(sessionCookie("t", new Date(Date.now() - 5000), false)).get("max-age"), "0");
  });

  it("adds Secure when requested", () => {
    assert.ok(attributes(sessionCookie("t", new Date(Date.now() + 1000), true)).has("secure"));
  });
});

describe("clearedSessionCookie", () => {
  it("expires the cookie immediately with the same scope", () => {
    const header = clearedSessionCookie(false);
    assert.ok(header.startsWith(`${SESSION_COOKIE}=; `));
    const attrs = attributes(header);
    assert.equal(attrs.get("max-age"), "0");
    assert.equal(attrs.get("path"), "/");
    assert.ok(attrs.has("httponly"));
    assert.ok(attributes(clearedSessionCookie(true)).has("secure"));
  });
});

describe("isSecureRequest", () => {
  const original = process.env.COOKIE_SECURE;
  afterEach(() => {
    if (original === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = original;
  });

  it("follows the request protocol by default", () => {
    delete process.env.COOKIE_SECURE;
    assert.equal(isSecureRequest(fakeRequest({ protocol: "https" })), true);
    assert.equal(isSecureRequest(fakeRequest({ protocol: "http" })), false);
  });

  it("COOKIE_SECURE=true/1 forces Secure (app behind an HTTPS proxy)", () => {
    for (const value of ["true", "1"]) {
      process.env.COOKIE_SECURE = value;
      assert.equal(isSecureRequest(fakeRequest({ protocol: "http" })), true, value);
    }
  });

  it("COOKIE_SECURE=false/0 disables it", () => {
    for (const value of ["false", "0"]) {
      process.env.COOKIE_SECURE = value;
      assert.equal(isSecureRequest(fakeRequest({ protocol: "https" })), false, value);
    }
  });
});
