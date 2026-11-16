/**
 * Integration test for device events: boots the real server against the fake
 * ThinQ API with fast polling, subscribes devices over the HTTP API and
 * follows their state changes through the history endpoint and the live
 * Server-Sent Events stream - including the security rules around streams.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { DISHWASHER_ID, FRIDGE_ID } from "./fake-thinq/devices.js";
import { FakeThinQ } from "./fake-thinq/server.js";
import { ApiClient, ROOT, eventData, startAppServer, waitFor, type AppServer, type SseMessage } from "./helpers/app-server.js";

const MINUTE = 60_000;
const POLL_MS = 100;
const isEvent = (deviceId: string, path: string, to?: unknown) => (m: SseMessage) => {
  if (!m.data) return false;
  const e = eventData(m);
  return e.deviceId === deviceId && e.kind === "event" && !!e.payload.changes?.some((c) => c.path === path && (to === undefined || c.to === to));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("device events over the HTTP API", () => {
  let clock = Date.parse("2026-01-01T08:00:00Z");
  const fake = new FakeThinQ({ accessToken: "pat-test", now: () => clock });
  let server: AppServer;
  let alice: ApiClient;
  let anonymous: ApiClient;

  const statePolls = (deviceId: string) => fake.requests.filter((r) => r.path === `/devices/${deviceId}/state`).length;
  const subscriptions = async () => (await alice.request("/api/subscriptions")).body;
  const subscriptionOf = async (deviceId: string) =>
    (await subscriptions()).subscriptions.find((s: { deviceId: string }) => s.deviceId === deviceId);
  const baselineTaken = (deviceId: string) =>
    waitFor(async () => (await subscriptionOf(deviceId))?.lastPolledAt, `baseline of ${deviceId}`);

  before(async () => {
    await fake.listen();
    server = await startAppServer(fake.url, { EVENT_POLL_INTERVAL_SECONDS: String(POLL_MS / 1000) });
    await server.addUser("alice", "secret123");
    await server.addUser("bob", "secret456");
    alice = new ApiClient(server.base);
    anonymous = new ApiClient(server.base);
    await alice.login("alice", "secret123");
    assert.equal((await alice.request("/api/devices/sync", { method: "POST" })).status, 200);
  });

  after(async () => {
    await server?.stop();
    await fake.close();
  });

  describe("access control", () => {
    it("requires a session for every event endpoint, without reaching ThinQ", async () => {
      const before = fake.requests.length;
      assert.equal((await anonymous.request("/api/subscriptions")).status, 401);
      assert.equal((await anonymous.request(`/api/devices/${FRIDGE_ID}/subscription`, { method: "PUT" })).status, 401);
      assert.equal((await anonymous.request(`/api/devices/${FRIDGE_ID}/subscription`, { method: "DELETE" })).status, 401);
      assert.equal((await anonymous.request("/api/events")).status, 401);
      const stream = await anonymous.stream();
      assert.equal(stream.status, 401);
      const forged = await anonymous.stream("/api/events/stream", { Cookie: "lg_home_session=forged" });
      assert.equal(forged.status, 401);
      assert.equal(fake.requests.length, before);
      assert.deepEqual((await alice.request("/api/subscriptions")).body.subscriptions, [], "nothing was subscribed");
    });
  });

  describe("input validation", () => {
    it("404s unknown devices", async () => {
      assert.equal((await alice.request("/api/devices/unknown/subscription", { method: "PUT" })).status, 404);
      assert.equal((await alice.request("/api/devices/unknown/subscription", { method: "DELETE" })).status, 404);
    });

    it("rejects malformed parameters", async () => {
      const long = "x".repeat(257);
      // Fastify refuses path parameters over 100 characters before routing.
      assert.equal((await alice.request(`/api/devices/${long}/subscription`, { method: "PUT" })).status, 414);
      for (const query of ["kind=push", "kind=", "limit=0", "limit=201", "limit=abc", "before=0", "before=-1", `deviceId=${long}`]) {
        assert.equal((await alice.request(`/api/events?${query}`)).status, 400, query);
      }
      // Unknown parameters are stripped by validation (Fastify's default), never used.
      assert.equal((await alice.request("/api/events?unknown=1")).status, 200);
      assert.equal((await alice.stream("/api/events/stream?kind=push")).status, 400);
      for (const bad of ["abc", "-1", "1.5", "1e3", "9".repeat(16)]) {
        const stream = await alice.stream("/api/events/stream", { "Last-Event-ID": bad });
        assert.equal(stream.status, 400, bad);
      }
    });
  });

  describe("subscribing", () => {
    it("subscribes a device (201), idempotently (200)", async () => {
      const first = await alice.request(`/api/devices/${DISHWASHER_ID}/subscription`, { method: "PUT" });
      assert.equal(first.status, 201);
      assert.equal(first.body.deviceId, DISHWASHER_ID);
      assert.equal(first.body.alias, "Dishwasher");
      assert.equal(first.body.type, "DEVICE_DISH_WASHER");
      assert.equal(first.body.createdBy, "alice");
      assert.equal(first.body.lastError, null);

      const again = await alice.request(`/api/devices/${DISHWASHER_ID}/subscription`, { method: "PUT" });
      assert.equal(again.status, 200);
      assert.equal(again.body.createdAt, first.body.createdAt);
    });

    it("takes a baseline promptly and reports the poller status", async () => {
      await baselineTaken(DISHWASHER_ID);
      const { poller, subscriptions: list } = await subscriptions();
      assert.equal(poller.state, "idle");
      assert.equal(poller.intervalMs, POLL_MS);
      assert.equal(poller.lastError, null);
      assert.deepEqual(list.map((s: { deviceId: string }) => s.deviceId), [DISHWASHER_ID]);
      assert.deepEqual((await alice.request("/api/events?kind=event")).body, [], "a baseline is not an event");
    });

    it("shares subscriptions between users", async () => {
      const bob = new ApiClient(server.base);
      await bob.login("bob", "secret456");
      const { body } = await bob.request("/api/subscriptions");
      assert.deepEqual(body.subscriptions.map((s: { deviceId: string }) => s.deviceId), [DISHWASHER_ID]);
    });
  });

  describe("live events and history", () => {
    it("streams state changes, and control commands, as they happen", async () => {
      const stream = await alice.stream();
      try {
        assert.equal(stream.status, 200);
        assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/);
        assert.match(stream.headers.get("cache-control") ?? "", /no-store/);
        await stream.next((m) => m.retry !== undefined, "retry hint");

        // Someone presses "remote start" on the appliance.
        fake.device(DISHWASHER_ID)!.patchState({ remoteControlEnable: { remoteControlEnabled: true } });
        const remote = eventData(await stream.next(isEvent(DISHWASHER_ID, "remoteControlEnable.remoteControlEnabled", true), "remote start event"));
        assert.deepEqual(remote.payload.report, { remoteControlEnable: { remoteControlEnabled: true } });
        assert.equal(remote.payload.source, "poll");

        const start = { operation: { dishWasherOperationMode: "START" } };
        assert.equal((await alice.request(`/api/devices/${DISHWASHER_ID}/control`, { method: "POST", body: JSON.stringify(start) })).status, 200);
        const control = eventData(await stream.next((m) => !!m.data && eventData(m).kind === "control", "control event"));
        assert.deepEqual(control.payload, start);
        await stream.next(isEvent(DISHWASHER_ID, "runState.currentState", "RUNNING"), "RUNNING event");

        clock += 135 * MINUTE; // the programme runs to the end
        await stream.next(isEvent(DISHWASHER_ID, "runState.currentState", "END"), "END event");

        // SSE ids are the event ids, strictly increasing.
        const ids = stream.messages.filter((m) => m.id).map((m) => Number(m.id));
        assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
        assert.equal(new Set(ids).size, ids.length);
        for (const m of stream.messages.filter((m) => m.id)) assert.equal(eventData(m).id, Number(m.id));
      } finally {
        stream.close();
      }
    });

    it("serves the history newest first, with filters and paging", async () => {
      const all = (await alice.request(`/api/events?deviceId=${DISHWASHER_ID}`)).body;
      assert.ok(all.length >= 4);
      const ids = all.map((e: { id: number }) => e.id);
      assert.deepEqual(ids, [...ids].sort((a: number, b: number) => b - a));
      assert.equal(all[0].payload.changes.some((c: { path: string; to: unknown }) => c.path === "runState.currentState" && c.to === "END"), true);

      const controls = (await alice.request("/api/events?kind=control")).body;
      assert.deepEqual(controls.map((e: { kind: string }) => e.kind), ["control"]);

      const page1 = (await alice.request(`/api/events?deviceId=${DISHWASHER_ID}&limit=2`)).body;
      const page2 = (await alice.request(`/api/events?deviceId=${DISHWASHER_ID}&limit=2&before=${page1[1].id}`)).body;
      assert.deepEqual([...page1, ...page2].map((e: { id: number }) => e.id), ids.slice(0, 4));
      assert.deepEqual((await alice.request(`/api/events?deviceId=${FRIDGE_ID}`)).body, []);
    });

    it("replays missed events to a reconnecting client (Last-Event-ID)", async () => {
      const history = (await alice.request(`/api/events?deviceId=${DISHWASHER_ID}`)).body.reverse();
      const stream = await alice.stream("/api/events/stream", { "Last-Event-ID": String(history[0].id) });
      try {
        const expected = history.slice(1).map((e: { id: number }) => String(e.id));
        await waitFor(() => stream.messages.filter((m) => m.id).length >= expected.length, "replay");
        assert.deepEqual(stream.messages.filter((m) => m.id).map((m) => m.id), expected);
      } finally {
        stream.close();
      }
    });

    it("filters a stream by device and kind", async () => {
      const controls = await alice.stream(`/api/events/stream?kind=control`, { "Last-Event-ID": "0" });
      const fridgeOnly = await alice.stream(`/api/events/stream?deviceId=${FRIDGE_ID}`, { "Last-Event-ID": "0" });
      try {
        await controls.next((m) => !!m.data && eventData(m).kind === "control", "replayed control event");
        await sleep(200);
        assert.ok(controls.messages.filter((m) => m.data).every((m) => eventData(m).kind === "control"));
        assert.deepEqual(fridgeOnly.messages.filter((m) => m.data), []);
      } finally {
        controls.close();
        fridgeOnly.close();
      }
    });

    it("never polls or reports a device that isn't subscribed", async () => {
      assert.equal(statePolls(FRIDGE_ID), 0);
      fake.device(FRIDGE_ID)!.patchState({ powerSave: { powerSaveEnabled: true } });
      await sleep(5 * POLL_MS);
      assert.equal(statePolls(FRIDGE_ID), 0);
      assert.deepEqual((await alice.request(`/api/events?deviceId=${FRIDGE_ID}`)).body, []);
    });
  });

  describe("problems", () => {
    it("reports an offline device on its subscription, and recovers", async () => {
      assert.equal((await alice.request(`/api/devices/${FRIDGE_ID}/subscription`, { method: "PUT" })).status, 201);
      await baselineTaken(FRIDGE_ID);
      fake.device(FRIDGE_ID)!.online = false;
      const failing = await waitFor(async () => {
        const s = await subscriptionOf(FRIDGE_ID);
        return s?.lastError ? s : undefined;
      }, "fridge error");
      assert.match(failing.lastError, /1222/);
      assert.equal((await subscriptions()).poller.state, "idle", "other devices keep being polled");

      fake.device(FRIDGE_ID)!.online = true;
      await waitFor(async () => (await subscriptionOf(FRIDGE_ID))?.lastError === null, "fridge recovery", 10_000);
    });

    it("pauses polling when ThinQ rate-limits the account, and resumes", async () => {
      fake.injectFault({ error: "EXCEEDED_API_CALLS", times: Infinity });
      const paused = await waitFor(async () => {
        const { poller } = await subscriptions();
        return poller.state === "paused" ? poller : undefined;
      }, "pause");
      assert.match(paused.lastError, /1306/);
      assert.ok(Date.parse(paused.resumesAt) > Date.now() - 1000);

      fake.clearFaults();
      await waitFor(async () => (await subscriptions()).poller.state === "idle", "resume", 10_000);
    });
  });

  describe("stream security", () => {
    it("limits open streams per user", async () => {
      const streams = [];
      try {
        for (let i = 0; i < 5; i++) {
          const s = await alice.stream();
          assert.equal(s.status, 200);
          streams.push(s);
        }
        const refused = await alice.stream();
        assert.equal(refused.status, 429);

        streams.pop()!.close();
        await waitFor(async () => {
          const s = await alice.stream();
          if (s.status === 200) streams.push(s);
          return s.status === 200;
        }, "a free slot after closing one");
      } finally {
        for (const s of streams) s.close();
      }
    });

    it("ends the stream when its session logs out, and only that session's", async () => {
      const other = new ApiClient(server.base);
      await other.login("alice", "secret123");
      const mine = await alice.stream();
      const theirs = await other.stream();
      await mine.next((m) => m.retry !== undefined, "stream open");
      await theirs.next((m) => m.retry !== undefined, "stream open");

      assert.equal((await other.request("/api/auth/logout", { method: "POST" })).status, 200);
      await theirs.ended;

      fake.device(FRIDGE_ID)!.patchState({ powerSave: { powerSaveEnabled: false } });
      await mine.next(isEvent(FRIDGE_ID, "powerSave.powerSaveEnabled", false), "event on the remaining stream");
      mine.close();
    });

    it("stops delivering events once the user's password changes", async () => {
      const bob = new ApiClient(server.base);
      await bob.login("bob", "secret456");
      const stream = await bob.stream();
      await stream.next((m) => m.retry !== undefined, "stream open");

      // An admin resets bob's password from another process, which drops his sessions.
      await server.addUser("bob", "new-secret-789", { force: true });
      const watcher = await alice.stream();
      try {
        fake.device(FRIDGE_ID)!.patchState({ powerSave: { powerSaveEnabled: true } });
        await watcher.next(isEvent(FRIDGE_ID, "powerSave.powerSaveEnabled", true), "the event itself");
        await stream.ended;
        assert.deepEqual(stream.messages.filter((m) => m.data), [], "bob's stream got nothing after the reset");
        assert.equal((await bob.request("/api/events")).status, 401);
      } finally {
        watcher.close();
      }
    });
  });

  describe("unsubscribing", () => {
    it("stops polling and reporting a device, idempotently", async () => {
      assert.equal((await alice.request(`/api/devices/${FRIDGE_ID}/subscription`, { method: "DELETE" })).status, 204);
      assert.equal((await alice.request(`/api/devices/${FRIDGE_ID}/subscription`, { method: "DELETE" })).status, 204);
      assert.equal(await subscriptionOf(FRIDGE_ID), undefined);

      await sleep(2 * POLL_MS); // let an in-flight cycle finish
      const polls = statePolls(FRIDGE_ID);
      const events = (await alice.request(`/api/events?deviceId=${FRIDGE_ID}`)).body.length;
      fake.device(FRIDGE_ID)!.patchState({ refrigeration: { expressMode: true } });
      await sleep(5 * POLL_MS);
      assert.equal(statePolls(FRIDGE_ID), polls);
      assert.equal((await alice.request(`/api/events?deviceId=${FRIDGE_ID}`)).body.length, events, "past events are kept, no new ones");
    });
  });

  describe("shutdown", () => {
    it("ends open streams and exits cleanly on SIGTERM", async () => {
      const stream = await alice.stream();
      await stream.next((m) => m.retry !== undefined, "stream open");
      server.process.kill("SIGTERM");
      await stream.ended;
      assert.equal(await server.exited, 0);
    });
  });
});

describe("server startup", () => {
  it("refuses to poll the real ThinQ API more often than every 15 s", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_PATH: ":memory:",
        PORT: "0",
        THINQ_API_BASE_URL: "https://api-aic.lgthinq.com",
        EVENT_POLL_INTERVAL_SECONDS: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (c) => (stderr += c));
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.notEqual(code, 0);
    assert.match(stderr, /EVENT_POLL_INTERVAL_SECONDS must be between 15 and/);
  });
});
