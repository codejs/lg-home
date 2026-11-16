import { resetDb } from "../../helpers/test-db.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { FastifyInstance, HTTPMethods, RouteOptions } from "fastify";
import { ThinQConfigError, ThinQError } from "../../../src/server/thinq/client.js";
import { as, buildTestApp, createUser, login } from "../../helpers/app.js";
import type { StubThinQ } from "../../helpers/stub-thinq.js";

/** The only API routes reachable without a session. Changing this list is a security decision. */
const PUBLIC_ROUTES = ["GET /api/auth/me", "HEAD /api/auth/me", "POST /api/auth/login", "POST /api/auth/logout"];

describe("auth gate", () => {
  const routes: { method: string; url: string }[] = [];
  let app: FastifyInstance;
  let thinq: StubThinQ;

  before(async () => {
    resetDb();
    await createUser();
    ({ app, thinq } = await buildTestApp({
      onRoute: (r: RouteOptions) => {
        for (const method of ([] as HTTPMethods[]).concat(r.method)) routes.push({ method, url: r.url });
      },
    }));
  });
  after(() => app.close());

  /** Concrete URL for a route pattern. */
  const concrete = (url: string) => url.replace(/:(\w+)/g, "some-$1");
  const isPublic = (r: { method: string; url: string }) => PUBLIC_ROUTES.includes(`${r.method} ${r.url}`);

  it("knows about all the API routes (sanity check for the audit below)", () => {
    const api = routes.filter((r) => r.url.startsWith("/api/"));
    assert.ok(api.length >= 10, `only saw ${api.length} routes`);
    assert.ok(api.some((r) => r.url === "/api/devices/:id/control"));
  });

  it("the public allowlist matches exactly what the app exposes", () => {
    const publicRoutes = routes.filter(isPublic).map((r) => `${r.method} ${r.url}`).sort();
    assert.deepEqual(publicRoutes, [...PUBLIC_ROUTES].sort());
  });

  it("every other API route refuses anonymous requests, and never runs its handler", async (t) => {
    const protectedRoutes = routes.filter((r) => r.url.startsWith("/api/") && !isPublic(r));
    for (const route of protectedRoutes) {
      await t.test(`${route.method} ${route.url}`, async () => {
        for (const cookie of [undefined, "lg_home_session=forged", "lg_home_session=", "other=1"]) {
          const res = await app.inject({
            method: route.method as HTTPMethods,
            url: concrete(route.url),
            headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
            payload: route.method === "GET" || route.method === "HEAD" ? undefined : "{}",
          });
          assert.equal(res.statusCode, 401, `cookie=${cookie}`);
        }
      });
    }
    assert.deepEqual(thinq.calls, [], "no handler reached ThinQ");
  });

  it("also gates unknown API paths (no route discovery without a session)", async () => {
    for (const url of ["/api/nope", "/api/devices/x/y/z", "/api/admin", "/api/"]) {
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401, url);
    }
  });

  it("is not fooled by encoding or query-string tricks", async () => {
    for (const url of [
      "/api/devices?/api/auth/login",
      "/api/devices#/api/auth/me",
      "/%61pi/devices",
      "/api/%64evices",
      "/api/devices/..%2F..%2Fauth%2Fme/status",
      "/api/auth/../devices",
    ]) {
      const res = await app.inject({ method: "GET", url });
      assert.notEqual(res.statusCode, 200, url);
      assert.ok(!res.body.startsWith("["), `${url} leaked a device list`);
    }
  });

  it("lets a valid session through", async () => {
    const cookie = await login(app);
    assert.equal((await as(app, cookie, { method: "GET", url: "/api/devices" })).statusCode, 200);
  });
});

describe("error handling", () => {
  let app: FastifyInstance;
  let thinq: StubThinQ;
  let cookie: string;
  const sync = () => as(app, cookie, { method: "POST", url: "/api/devices/sync" });

  beforeEach(async () => {
    resetDb();
    await createUser();
    ({ app, thinq } = await buildTestApp());
    cookie = await login(app);
  });
  afterEach(() => app.close());

  it("ThinQ error responses become 502 with ThinQ's status and code", async () => {
    thinq.error = new ThinQError("ThinQ API error 401 (code 1103): Invalid token", "response", 401, "1103");
    const res = await sync();
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json(), { error: "ThinQ API error 401 (code 1103): Invalid token", thinqStatus: 401, thinqCode: "1103" });
  });

  it("an upstream 401 does not log the user out of this app", async () => {
    thinq.error = new ThinQError("expired PAT", "response", 401, "1103");
    assert.equal((await sync()).statusCode, 502, "must not be a 401, or the SPA would show the login page");
  });

  it("ThinQ timeouts become 504", async () => {
    thinq.error = new ThinQError("ThinQ API did not respond within 15000 ms", "timeout");
    const res = await sync();
    assert.equal(res.statusCode, 504);
    assert.equal(res.json().thinqStatus, null);
  });

  it("network failures become 502", async () => {
    thinq.error = new ThinQError("Could not reach the ThinQ API: ENOTFOUND", "network");
    assert.equal((await sync()).statusCode, 502);
  });

  it("missing configuration becomes 503 with guidance", async () => {
    thinq.error = new ThinQConfigError("THINQ_ACCESS_TOKEN and THINQ_COUNTRY_CODE must be set");
    const res = await sync();
    assert.equal(res.statusCode, 503);
    assert.match(res.json().error, /THINQ_ACCESS_TOKEN/);
  });

  // Regression: unexpected errors were sent verbatim, leaking SQL, constraint names and codes.
  it("unexpected errors become a generic 500 without internals", async () => {
    const err = Object.assign(new Error("NOT NULL constraint failed: sessions.expires_at at /srv/app/db.ts:42"), {
      code: "SQLITE_CONSTRAINT_NOTNULL",
    });
    thinq.error = err;
    const res = await sync();
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { error: "Internal Server Error" });
    for (const secret of ["SQLITE", "constraint", "/srv/app", "expires_at"]) {
      assert.ok(!res.body.includes(secret), `leaked "${secret}"`);
    }
  });

  it("non-Error throws are handled too", async () => {
    thinq.error = "a bare string";
    const res = await sync();
    assert.equal(res.statusCode, 500);
    assert.ok(!res.body.includes("bare string"));
  });

  it("client errors (4xx) keep their helpful message", async () => {
    const res = await as(app, cookie, { method: "GET", url: "/api/devices/x/history?limit=0" });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /limit/);
  });
});

describe("static SPA hosting", () => {
  let root: string;
  let app: FastifyInstance;

  before(async () => {
    resetDb();
    await createUser();
    root = mkdtempSync(join(tmpdir(), "lg-home-web-"));
    const webDir = join(root, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>LG Home</title>");
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')");
    writeFileSync(join(root, "secret.txt"), "TOP-SECRET");
    ({ app } = await buildTestApp({ webDir }));
  });
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves the SPA and its assets without a session (the login page lives there)", async () => {
    const index = await app.inject({ method: "GET", url: "/" });
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /LG Home/);
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers["content-type"]), /javascript/);
  });

  it("falls back to index.html for client-side routes", async () => {
    const res = await app.inject({ method: "GET", url: "/devices/some-id" });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /LG Home/);
  });

  it("answers unknown API paths with JSON 404, not the SPA", async () => {
    const cookie = await login(app);
    const res = await as(app, cookie, { method: "GET", url: "/api/does-not-exist" });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: "Not found" });
  });

  it("blocks path traversal out of the web root", async () => {
    for (const url of [
      "/../secret.txt",
      "/..%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/assets/../../secret.txt",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/....//secret.txt",
    ]) {
      const res = await app.inject({ method: "GET", url });
      assert.ok(!res.body.includes("TOP-SECRET"), `${url} leaked a file outside the web root`);
    }
  });

  it("does not list directories", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/" });
    assert.ok(!res.body.includes("app.js"));
  });

  it("without a built SPA, non-API paths are plain 404s", async () => {
    const { app: apiOnly } = await buildTestApp({ webDir: join(root, "missing") });
    try {
      assert.equal((await apiOnly.inject({ method: "GET", url: "/" })).statusCode, 404);
    } finally {
      await apiOnly.close();
    }
  });
});
