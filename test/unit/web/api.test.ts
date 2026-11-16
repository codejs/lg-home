import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ApiError, api, setUnauthorizedHandler } from "../../../src/web/api.js";
import { installFetch, json } from "../../helpers/fetch.js";

describe("web api client", () => {
  let fetchStub: ReturnType<typeof installFetch>;
  let unauthorized = 0;

  beforeEach(() => {
    unauthorized = 0;
    setUnauthorizedHandler(() => unauthorized++);
  });
  afterEach(() => fetchStub?.restore());

  describe("requests", () => {
    it("sends cookies same-origin only, and JSON headers only with a body", async () => {
      fetchStub = installFetch({
        "GET /api/devices": () => json(200, []),
        "POST /api/devices/d1/control": () => json(200, { ok: true }),
      });
      await api.devices();
      await api.control("d1", { a: 1 });
      const [get, post] = fetchStub.calls;
      assert.equal(get.init.credentials, "same-origin", "never include cookies cross-origin");
      assert.equal(get.init.headers, undefined);
      assert.equal(post.init.credentials, "same-origin");
      assert.deepEqual(post.init.headers, { "Content-Type": "application/json" });
      assert.deepEqual(post.body, { a: 1 });
    });

    it("uses relative URLs (same origin as the SPA)", async () => {
      fetchStub = installFetch({ "GET /api/devices": () => json(200, []) });
      await api.devices();
      assert.equal(fetchStub.calls[0].url, "/api/devices");
    });

    // Regression: ids were interpolated raw, so "/", "?" or "#" could retarget the request.
    it("encodes device ids in paths", async () => {
      const id = "../auth/logout?x=1#y";
      const enc = encodeURIComponent(id);
      fetchStub = installFetch({
        [`GET /api/devices/${enc}/status`]: () => json(200, { s: 1 }),
        [`POST /api/devices/${enc}/control`]: () => json(200, {}),
      });
      assert.deepEqual(await api.status(id), { s: 1 });
      await api.control(id, { a: 1 });
      assert.deepEqual(
        fetchStub.calls.map((c) => c.url),
        [`/api/devices/${enc}/status`, `/api/devices/${enc}/control`],
      );
    });

    it("syncs with POST and returns the device list", async () => {
      fetchStub = installFetch({ "POST /api/devices/sync": () => json(200, [{ id: "d1" }]) });
      assert.deepEqual(await api.syncDevices(), [{ id: "d1" }]);
    });
  });

  describe("errors", () => {
    it("throws ApiError carrying the server's error message and status", async () => {
      fetchStub = installFetch({ "GET /api/devices": () => json(502, { error: "ThinQ API error 400", thinqCode: "1222" }) });
      await assert.rejects(api.devices(), (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 502);
        assert.equal(err.message, "ThinQ API error 400");
        assert.equal(err.name, "ApiError");
        return true;
      });
    });

    it("falls back to `message`, then to the status line", async () => {
      fetchStub = installFetch({
        "GET /api/devices": () => json(400, { message: "querystring/limit must be >= 1" }),
        "POST /api/devices/sync": () => new Response("<html>gateway down</html>", { status: 503, statusText: "Service Unavailable" }),
      });
      await assert.rejects(api.devices(), /querystring\/limit/);
      await assert.rejects(api.syncDevices(), /503 Service Unavailable/);
    });

    it("propagates network failures", async () => {
      fetchStub = installFetch({
        "GET /api/devices": () => {
          throw new TypeError("Failed to fetch");
        },
      });
      await assert.rejects(api.devices(), /Failed to fetch/);
      assert.equal(unauthorized, 0);
    });
  });

  describe("session expiry", () => {
    it("a 401 on a normal call triggers the unauthorized handler", async () => {
      fetchStub = installFetch({ "GET /api/devices": () => json(401, { error: "Authentication required" }) });
      await assert.rejects(api.devices(), ApiError);
      assert.equal(unauthorized, 1);
    });

    it("a 401 from login is a wrong password, not an expired session", async () => {
      fetchStub = installFetch({ "POST /api/auth/login": () => json(401, { error: "Invalid username or password" }) });
      await assert.rejects(api.login("alice", "nope"), /Invalid username or password/);
      assert.equal(unauthorized, 0);
    });

    it("other failures (403, 429, 500) don't end the session", async () => {
      for (const status of [403, 429, 500]) {
        fetchStub = installFetch({ "GET /api/devices": () => json(status, { error: "x" }) });
        await assert.rejects(api.devices());
        fetchStub.restore();
      }
      assert.equal(unauthorized, 0);
    });
  });

  describe("auth calls", () => {
    it("me() returns the user, or null when signed out", async () => {
      fetchStub = installFetch({ "GET /api/auth/me": () => json(200, { user: { id: 1, username: "alice" } }) });
      assert.deepEqual(await api.me(), { id: 1, username: "alice" });
      fetchStub.restore();
      fetchStub = installFetch({ "GET /api/auth/me": () => json(401, { error: "Authentication required" }) });
      assert.equal(await api.me(), null);
      assert.equal(unauthorized, 0, "being signed out on load is not an expiry event");
    });

    it("me() surfaces server errors instead of pretending to be signed out", async () => {
      fetchStub = installFetch({ "GET /api/auth/me": () => json(500, { error: "Internal Server Error" }) });
      await assert.rejects(api.me(), (err: unknown) => err instanceof ApiError && err.status === 500);
    });

    it("login posts the credentials exactly as typed", async () => {
      fetchStub = installFetch({ "POST /api/auth/login": () => json(200, { user: { id: 1, username: "alice" } }) });
      const user = await api.login(" Alice ", "  pass word  ");
      assert.deepEqual(user, { id: 1, username: "alice" });
      assert.deepEqual(fetchStub.calls[0].body, { username: " Alice ", password: "  pass word  " });
    });

    it("logout posts without a body", async () => {
      fetchStub = installFetch({ "POST /api/auth/logout": () => json(200, { ok: true }) });
      assert.deepEqual(await api.logout(), { ok: true });
      assert.equal(fetchStub.calls[0].init.body, undefined);
    });
  });
});
