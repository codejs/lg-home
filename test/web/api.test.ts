/** The browser API client's event and subscription calls. */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { api, ApiError, notifyUnauthorized, setUnauthorizedHandler } from "../../src/web/api";
import { DW, FakeBackend, stateEvent } from "./helpers";

describe("api client: events", () => {
  let backend: FakeBackend;
  let unauthorized = 0;
  beforeEach(() => {
    backend = new FakeBackend();
    unauthorized = 0;
    setUnauthorizedHandler(() => unauthorized++);
  });

  it("subscribes and unsubscribes with PUT and DELETE, escaping the device id", async () => {
    backend.devices.push({ ...backend.devices[0], id: "odd/id?x=1" });
    const sub = await api.subscribe("odd/id?x=1");
    assert.equal(sub.deviceId, "odd/id?x=1");
    assert.equal(backend.requests.at(-1)!.method, "PUT");
    assert.equal(backend.requests.at(-1)!.path, "/api/devices/odd%2Fid%3Fx%3D1/subscription");

    assert.equal(await api.unsubscribe("odd/id?x=1"), null, "204 has no body");
    assert.equal(backend.requests.at(-1)!.method, "DELETE");
  });

  it("lists subscriptions with the poller status", async () => {
    backend.subscribe(DW);
    const { poller, subscriptions } = await api.subscriptions();
    assert.equal(poller.state, "idle");
    assert.deepEqual(subscriptions.map((s) => s.deviceId), [DW]);
  });

  it("builds the history query, leaving out empty parameters", async () => {
    backend.events = [stateEvent(1, DW, "a.b", 1, 2)];
    await api.events();
    assert.equal([...backend.requests.at(-1)!.query].length, 0);
    await api.events({ deviceId: DW, kind: "event", before: 10, limit: 5 });
    assert.deepEqual(Object.fromEntries(backend.requests.at(-1)!.query), { deviceId: DW, kind: "event", before: "10", limit: "5" });
    await api.events({ deviceId: "a&kind=control" });
    assert.equal(backend.requests.at(-1)!.query.get("deviceId"), "a&kind=control");
    assert.equal(backend.requests.at(-1)!.query.get("kind"), null);
  });

  it("asks for a page by offset and counts matching events", async () => {
    backend.events = [stateEvent(1, DW, "a.b", 1, 2), stateEvent(2, DW, "a.b", 2, 3), stateEvent(3, DW, "a.b", 3, 4)];
    assert.deepEqual((await api.events({ offset: 1, limit: 1, before: 3 })).map((e) => e.id), [1]);
    assert.deepEqual(Object.fromEntries(backend.requests.at(-1)!.query), { before: "3", offset: "1", limit: "1" });
    await api.events({ offset: 0 });
    assert.equal(backend.requests.at(-1)!.query.get("offset"), null, "offset 0 is left out");

    assert.deepEqual(await api.countEvents({ deviceId: DW, kind: "event", before: 3 }), { total: 2 });
    const count = backend.requests.at(-1)!;
    assert.equal(count.path, "/api/events/count");
    assert.deepEqual(Object.fromEntries(count.query), { deviceId: DW, kind: "event", before: "3" });
  });

  it("surfaces server errors and reports an ended session", async () => {
    backend.fail("PUT /api/devices/dw-1/subscription", 502, "ThinQ is down");
    await assert.rejects(api.subscribe(DW), (err: unknown) => err instanceof ApiError && err.status === 502 && err.message === "ThinQ is down");
    assert.equal(unauthorized, 0);

    backend.user = null;
    await assert.rejects(api.events(), (err: unknown) => err instanceof ApiError && err.status === 401);
    assert.equal(unauthorized, 1);
  });

  it("lets the event stream report an ended session", () => {
    notifyUnauthorized();
    assert.equal(unauthorized, 1);
  });
});
