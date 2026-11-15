import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  DEFAULT_API_KEY,
  ThinQClient,
  ThinQConfigError,
  ThinQError,
  baseUrlForRegion,
  newMessageId,
  regionForCountry,
} from "../src/server/thinq/client.js";
import { MockThinQ, fail, ok } from "./helpers/mock-thinq.js";

describe("regions", () => {
  it("maps countries to their regional API server", () => {
    assert.equal(regionForCountry("US"), "AIC");
    assert.equal(regionForCountry("br"), "AIC");
    assert.equal(regionForCountry("GB"), "EIC");
    assert.equal(regionForCountry("DE"), "EIC");
    assert.equal(regionForCountry("KR"), "KIC");
    assert.equal(regionForCountry(" au "), "KIC");
    assert.equal(baseUrlForRegion("EIC"), "https://api-eic.lgthinq.com");
  });

  it("rejects unknown countries with a config error", () => {
    assert.throws(() => regionForCountry("ZZ"), ThinQConfigError);
  });

  it("picks the base URL from the country unless overridden", () => {
    const common = { accessToken: "t", clientId: "c" };
    assert.equal(new ThinQClient({ ...common, countryCode: "US" }).baseUrl, "https://api-aic.lgthinq.com");
    assert.equal(new ThinQClient({ ...common, countryCode: "KR" }).baseUrl, "https://api-kic.lgthinq.com");
    assert.equal(
      new ThinQClient({ ...common, countryCode: "ZZ", region: "EIC" }).baseUrl,
      "https://api-eic.lgthinq.com",
    );
    assert.equal(
      new ThinQClient({ ...common, countryCode: "US", baseUrl: "http://localhost:9/" }).baseUrl,
      "http://localhost:9",
    );
  });
});

describe("newMessageId", () => {
  it("is 22 url-safe base64 characters and unique", () => {
    const a = newMessageId();
    assert.match(a, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(a, newMessageId());
  });
});

describe("ThinQClient", () => {
  const mock = new MockThinQ();
  let client: ThinQClient;

  before(() => mock.start());
  after(() => mock.stop());
  beforeEach(() => {
    mock.requests.length = 0;
    client = new ThinQClient({
      accessToken: "pat-123",
      countryCode: "us",
      clientId: "client-abc",
      baseUrl: mock.url,
      timeoutMs: 500,
    });
  });

  it("sends the ThinQ headers on every request", async () => {
    mock.handler = () => ok([]);
    await client.getDevices();
    const { headers } = mock.requests[0];
    assert.equal(headers.authorization, "Bearer pat-123");
    assert.equal(headers["x-country"], "US");
    assert.equal(headers["x-client-id"], "client-abc");
    assert.equal(headers["x-api-key"], DEFAULT_API_KEY);
    assert.equal(headers["x-service-phase"], "OP");
    assert.match(String(headers["x-message-id"]), /^[A-Za-z0-9_-]{22}$/);
  });

  it("uses a fresh message id per request", async () => {
    mock.handler = () => ok([]);
    await client.getDevices();
    await client.getDevices();
    assert.notEqual(mock.requests[0].headers["x-message-id"], mock.requests[1].headers["x-message-id"]);
  });

  it("lists devices and unwraps the response envelope", async () => {
    const devices = [{ deviceId: "d1", deviceInfo: { deviceType: "DEVICE_WASHER", alias: "Washer" } }];
    mock.handler = () => ok(devices);
    assert.deepEqual(await client.getDevices(), devices);
    assert.equal(mock.requests[0].method, "GET");
    assert.equal(mock.requests[0].url, "/devices");
  });

  it("treats a missing device list as empty", async () => {
    mock.handler = () => ({ status: 200, body: { messageId: "x", timestamp: "t" } });
    assert.deepEqual(await client.getDevices(), []);
  });

  it("reads state and profile from the right endpoints, escaping the id", async () => {
    mock.handler = (req) => ok({ url: req.url });
    assert.deepEqual(await client.getDeviceStatus("a/b c"), { url: "/devices/a%2Fb%20c/state" });
    assert.deepEqual(await client.getDeviceProfile("dev1"), { url: "/devices/dev1/profile" });
  });

  it("posts control commands as JSON with conditional control", async () => {
    mock.handler = () => ok({});
    const command = { operation: { washerOperationMode: "START" } };
    assert.deepEqual(await client.controlDevice("dev1", command), {});
    const req = mock.requests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/devices/dev1/control");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.headers["x-conditional-control"], "true");
    assert.deepEqual(req.body, command);
  });

  it("turns ThinQ error envelopes into ThinQError", async () => {
    mock.handler = () => fail(400, "1222", "Not connected device");
    await assert.rejects(client.getDeviceStatus("dev1"), (err: unknown) => {
      assert.ok(err instanceof ThinQError);
      assert.equal(err.reason, "response");
      assert.equal(err.status, 400);
      assert.equal(err.code, "1222");
      assert.match(err.message, /400.*1222.*Not connected device/);
      return true;
    });
  });

  it("handles error responses that are not JSON", async () => {
    mock.handler = () => ({ status: 503, body: "<html>Service Unavailable</html>" });
    await assert.rejects(client.getDevices(), (err: unknown) => {
      assert.ok(err instanceof ThinQError);
      assert.equal(err.status, 503);
      assert.equal(err.code, null);
      return true;
    });
  });

  it("rejects a success response that is not JSON", async () => {
    mock.handler = () => ({ status: 200, body: "<html>captive portal</html>" });
    await assert.rejects(client.getDevices(), /not JSON/);
  });

  it("times out slow responses", async () => {
    mock.handler = () => ({ ...ok([]), delayMs: 2_000 });
    await assert.rejects(client.getDevices(), (err: unknown) => {
      assert.ok(err instanceof ThinQError);
      assert.equal(err.reason, "timeout");
      assert.equal(err.status, null);
      return true;
    });
  });

  it("reports network failures", async () => {
    const offline = new ThinQClient({
      accessToken: "t",
      countryCode: "US",
      clientId: "c",
      baseUrl: "http://127.0.0.1:1",
    });
    await assert.rejects(offline.getDevices(), (err: unknown) => {
      assert.ok(err instanceof ThinQError);
      assert.equal(err.reason, "network");
      return true;
    });
  });

  it("requires a token and a client id", () => {
    assert.throws(() => new ThinQClient({ accessToken: "", countryCode: "US", clientId: "c" }), ThinQConfigError);
    assert.throws(() => new ThinQClient({ accessToken: "t", countryCode: "US", clientId: "" }), ThinQConfigError);
  });
});
