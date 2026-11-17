/**
 * The event poller and event store, in-process against the fake ThinQ API,
 * with a controllable clock and a throwaway database.
 */
import { db, schema } from "../../helpers/test-db.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { ThinQClient, ThinQConfigError } from "../../../src/server/thinq/client.js";
import { EventPoller, MAX_DEVICE_BACKOFF_MS, MAX_GLOBAL_BACKOFF_MS, type Logger } from "../../../src/server/events/poller.js";
import { startRetention } from "../../../src/server/events/retention.js";
import * as store from "../../../src/server/events/store.js";
import { EventBus } from "../../../src/server/events/bus.js";
import type { StoredEvent } from "../../../src/server/events/store.js";
import { DISHWASHER_ID, FRIDGE_ID } from "../../fake-thinq/devices.js";
import { FakeThinQ } from "../../fake-thinq/server.js";

/** The bus state changes are published on (one app's). */
const bus = new EventBus();

const MINUTE = 60_000;
const INTERVAL = MINUTE;
const START = Date.parse("2026-01-01T08:00:00Z");

/** A ThinQ client that can run a hook after each state read, or replace its result. */
class HookedClient extends ThinQClient {
  afterStatus?: (deviceId: string) => void;
  replaceStatus?: (deviceId: string) => Record<string, unknown> | undefined;
  override async getDeviceStatus(deviceId: string) {
    const state = await super.getDeviceStatus(deviceId);
    this.afterStatus?.(deviceId);
    return this.replaceStatus?.(deviceId) ?? state;
  }
}

describe("event poller", () => {
  let clock = START;
  const fake = new FakeThinQ({ accessToken: "pat-test", now: () => clock });
  let client: HookedClient;
  let logs: { level: string; obj: object; msg: string }[];
  const log: Logger = {
    info: (obj, msg) => logs.push({ level: "info", obj, msg }),
    warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
    error: (obj, msg) => logs.push({ level: "error", obj, msg }),
  };

  const newPoller = (options: { intervalMs?: number; client?: () => ThinQClient; now?: () => number } = {}) =>
    new EventPoller({ intervalMs: INTERVAL, client: () => client, log, bus, now: () => clock, ...options });

  const statePolls = (deviceId?: string) =>
    fake.requests.filter((r) => r.path.endsWith("/state") && (!deviceId || r.path === `/devices/${deviceId}/state`)).length;
  const allEvents = () => store.queryEvents({ limit: 1000 });
  const subscription = (id: string) => store.getSubscription(id)!;
  const enableRemoteStart = () => fake.device(DISHWASHER_ID)!.patchState({ remoteControlEnable: { remoteControlEnabled: true } });

  before(async () => {
    await fake.listen();
    client = new HookedClient({ accessToken: "pat-test", countryCode: "US", clientId: "poller-test", baseUrl: fake.url });
    const now = new Date(START);
    for (const d of fake.devices) {
      db.insert(schema.devices)
        .values({ id: d.deviceId, type: d.deviceInfo.deviceType, alias: d.deviceInfo.alias, updatedAt: now })
        .run();
    }
    db.insert(schema.users).values({ id: 1, username: "alice", passwordHash: "x", createdAt: now, updatedAt: now }).run();
  });

  after(async () => {
    await fake.close();
  });

  beforeEach(() => {
    fake.reset();
    clock = START;
    logs = [];
    client.afterStatus = undefined;
    client.replaceStatus = undefined;
    db.delete(schema.subscriptions).run();
    db.delete(schema.events).run();
  });

  describe("change detection", () => {
    it("makes no ThinQ calls - and doesn't even build a client - without subscriptions", async () => {
      let built = 0;
      const poller = newPoller({ client: () => (built++, client) });
      for (let i = 0; i < 3; i++) {
        await poller.runCycle();
        clock += INTERVAL;
      }
      assert.equal(fake.requests.length, 0);
      assert.equal(built, 0);
    });

    it("takes a baseline on the first poll without recording an event", async () => {
      store.subscribe(DISHWASHER_ID, 1);
      await newPoller().runCycle();
      assert.equal(statePolls(DISHWASHER_ID), 1);
      assert.deepEqual(allEvents(), []);
      const sub = subscription(DISHWASHER_ID);
      assert.equal(sub.lastPolledAt?.getTime(), START);
      assert.equal(sub.lastChangeAt, null);
      assert.equal(sub.createdBy, "alice");
    });

    it("records a state change as an event and publishes it", async () => {
      const published: StoredEvent[] = [];
      const off = bus.on((e) => published.push(e));
      try {
        store.subscribe(DISHWASHER_ID, 1);
        const poller = newPoller();
        await poller.runCycle();
        enableRemoteStart();
        clock += INTERVAL;
        await poller.runCycle();

        const events = allEvents();
        assert.equal(events.length, 1);
        assert.equal(events[0].deviceId, DISHWASHER_ID);
        assert.equal(events[0].kind, "event");
        assert.equal(events[0].createdAt.getTime(), clock);
        assert.deepEqual(events[0].payload, {
          source: "poll",
          report: { remoteControlEnable: { remoteControlEnabled: true } },
          changes: [{ path: "remoteControlEnable.remoteControlEnabled", from: false, to: true }],
        });
        assert.deepEqual(published, events);
        assert.equal(subscription(DISHWASHER_ID).lastChangeAt?.getTime(), clock);
      } finally {
        off();
      }
    });

    it("records nothing when nothing changed", async () => {
      store.subscribe(FRIDGE_ID, 1);
      const poller = newPoller();
      for (let i = 0; i < 3; i++) {
        await poller.runCycle();
        clock += INTERVAL;
      }
      assert.equal(statePolls(FRIDGE_ID), 3);
      assert.deepEqual(allEvents(), []);
    });

    it("follows a dishwasher programme to the end", async () => {
      store.subscribe(DISHWASHER_ID, 1);
      enableRemoteStart();
      const poller = newPoller();
      await poller.runCycle();

      await client.controlDevice(DISHWASHER_ID, { operation: { dishWasherOperationMode: "START" } });
      clock += INTERVAL;
      await poller.runCycle();
      clock += 135 * MINUTE;
      await poller.runCycle();

      const [end, start] = allEvents(); // newest first
      assert.deepEqual(start.payload.report, {
        runState: { currentState: "RUNNING" },
        timer: { remainHour: 2, remainMinute: 14, totalHour: 2, totalMinute: 15 },
      });
      assert.deepEqual(
        (end.payload.changes as { path: string }[]).find((c) => c.path === "runState.currentState"),
        { path: "runState.currentState", from: "RUNNING", to: "END" },
      );
    });

    it("keeps the baseline across restarts", async () => {
      store.subscribe(FRIDGE_ID, 1);
      await newPoller().runCycle();

      // Restarted with nothing changed: no false event.
      clock += INTERVAL;
      await newPoller().runCycle();
      assert.deepEqual(allEvents(), []);

      // Changed while the server was down: reported on the first poll after restart.
      fake.device(FRIDGE_ID)!.patchState({ powerSave: { powerSaveEnabled: true } });
      clock += INTERVAL;
      await newPoller().runCycle();
      assert.deepEqual(allEvents().map((e) => e.payload.report), [{ powerSave: { powerSaveEnabled: true } }]);
    });

    it("polls only subscribed devices", async () => {
      store.subscribe(FRIDGE_ID, 1);
      const poller = newPoller();
      await poller.runCycle();
      fake.device(DISHWASHER_ID)!.patchState({ doorStatus: { doorState: "OPEN" } });
      clock += INTERVAL;
      await poller.runCycle();
      assert.equal(statePolls(DISHWASHER_ID), 0);
      assert.equal(statePolls(FRIDGE_ID), 2);
      assert.deepEqual(allEvents(), []);
    });

    it("drops a poll result when the subscription was removed meanwhile", async () => {
      store.subscribe(FRIDGE_ID, 1);
      const poller = newPoller();
      await poller.runCycle();
      fake.device(FRIDGE_ID)!.patchState({ powerSave: { powerSaveEnabled: true } });
      client.afterStatus = (id) => store.unsubscribe(id);
      clock += INTERVAL;
      await poller.runCycle();
      assert.equal(statePolls(FRIDGE_ID), 2);
      assert.deepEqual(allEvents(), []);
      assert.equal(store.getSubscription(FRIDGE_ID), undefined, "not resurrected");
    });

    it("ignores states it can't safely use, and keeps the old baseline", async () => {
      store.subscribe(FRIDGE_ID, 1);
      const poller = newPoller();
      await poller.runCycle();

      let deep: Record<string, unknown> = { v: 1 };
      for (let i = 0; i < 100; i++) deep = { n: deep };
      client.replaceStatus = () => deep;
      clock += INTERVAL;
      await poller.runCycle();
      assert.match(subscription(FRIDGE_ID).lastError ?? "", /Ignored a state from ThinQ: .*deeper than/);
      assert.deepEqual(allEvents(), []);
      assert.equal(poller.status().state, "idle", "a bad state is a device problem, not an account one");

      client.replaceStatus = undefined;
      clock += INTERVAL;
      await poller.runCycle();
      assert.deepEqual(allEvents(), [], "baseline still the last good state");
      assert.equal(subscription(FRIDGE_ID).lastError, null);
    });

    it("keeps polling when an event listener throws", async () => {
      const off = bus.on(() => {
        throw new Error("listener broke");
      });
      try {
        store.subscribe(FRIDGE_ID, 1);
        const poller = newPoller();
        await poller.runCycle();
        fake.device(FRIDGE_ID)!.patchState({ powerSave: { powerSaveEnabled: true } });
        clock += INTERVAL;
        await poller.runCycle();
        fake.device(FRIDGE_ID)!.patchState({ powerSave: { powerSaveEnabled: false } });
        clock += INTERVAL;
        await poller.runCycle();
        assert.equal(allEvents().length, 2);
      } finally {
        off();
      }
    });

    it("loses the subscription (but not the events) when the device is deleted", async () => {
      store.subscribe(FRIDGE_ID, 1);
      store.recordEvent(bus, { deviceId: FRIDGE_ID, kind: "control", payload: { x: 1 } });
      const row = db.select().from(schema.devices).where(eq(schema.devices.id, FRIDGE_ID)).get()!;
      db.delete(schema.devices).where(eq(schema.devices.id, FRIDGE_ID)).run();
      try {
        assert.equal(store.getSubscription(FRIDGE_ID), undefined);
        assert.equal(allEvents().length, 1);
      } finally {
        db.insert(schema.devices).values(row).run();
      }
    });
  });

  describe("call budget", () => {
    it("polls each device at most once per interval, however often a cycle runs", async () => {
      store.subscribe(FRIDGE_ID, 1);
      store.subscribe(DISHWASHER_ID, 1);
      const poller = newPoller();
      await poller.runCycle();
      await poller.runCycle();
      clock += INTERVAL - 1;
      await poller.runCycle();
      assert.equal(statePolls(), 2);
      clock += 1;
      await poller.runCycle();
      assert.equal(statePolls(), 4);
    });

    it("never runs two cycles at once", async () => {
      store.subscribe(FRIDGE_ID, 1);
      store.subscribe(DISHWASHER_ID, 1);
      const poller = newPoller();
      const a = poller.runCycle();
      const b = poller.runCycle();
      assert.equal(a, b);
      await Promise.all([a, b]);
      assert.equal(statePolls(), 2);
    });

    it("can't be made to poll more by unsubscribing and re-subscribing", async () => {
      store.subscribe(FRIDGE_ID, 1);
      const poller = newPoller();
      await poller.runCycle();
      for (let i = 0; i < 5; i++) {
        store.unsubscribe(FRIDGE_ID);
        await poller.runCycle();
        store.subscribe(FRIDGE_ID, 1);
        await poller.runCycle();
      }
      assert.equal(statePolls(FRIDGE_ID), 1);

      clock += INTERVAL;
      await poller.runCycle();
      assert.equal(statePolls(FRIDGE_ID), 2);
      assert.deepEqual(allEvents(), [], "the new subscription starts from a fresh baseline");
    });
  });

  describe("failures", () => {
    it("backs off an offline device without holding up the others", async () => {
      store.subscribe(FRIDGE_ID, 1);
      store.subscribe(DISHWASHER_ID, 1);
      const poller = newPoller();
      await poller.runCycle();

      fake.device(FRIDGE_ID)!.online = false;
      fake.device(FRIDGE_ID)!.patchState({ powerSave: { powerSaveEnabled: true } });
      const fridgePollsAt: number[] = [];
      for (let minute = 1; minute <= 8; minute++) {
        clock = START + minute * INTERVAL;
        const before = statePolls(FRIDGE_ID);
        await poller.runCycle();
        if (statePolls(FRIDGE_ID) > before) fridgePollsAt.push(minute);
      }
      assert.deepEqual(fridgePollsAt, [1, 2, 4, 8], "retry after 1, 2, 4 minutes");
      assert.equal(statePolls(DISHWASHER_ID), 9, "dishwasher polled every cycle");
      assert.equal(poller.status().state, "idle");

      const sub = subscription(FRIDGE_ID);
      assert.match(sub.lastError ?? "", /1222/);
      assert.equal(sub.lastErrorAt?.getTime(), START + 8 * INTERVAL);
      assert.ok(logs.some((l) => l.level === "warn" && l.msg === "event poll failed for device"));

      // Back online: the change made while offline is reported and the error clears.
      fake.device(FRIDGE_ID)!.online = true;
      clock = START + 16 * INTERVAL;
      await poller.runCycle();
      assert.equal(subscription(FRIDGE_ID).lastError, null);
      assert.deepEqual(allEvents().map((e) => e.payload.report), [{ powerSave: { powerSaveEnabled: true } }]);

      // ... and the backoff resets.
      clock += INTERVAL;
      await poller.runCycle();
      assert.equal(statePolls(FRIDGE_ID), 7, "baseline + 4 retries + recovery + the next interval");
    });

    it("caps a device's backoff at 15 minutes", async () => {
      store.subscribe(FRIDGE_ID, 1);
      fake.device(FRIDGE_ID)!.online = false;
      const poller = newPoller();
      const pollsAt: number[] = [];
      for (let minute = 0; minute <= 120; minute++) {
        clock = START + minute * INTERVAL;
        const before = statePolls(FRIDGE_ID);
        await poller.runCycle();
        if (statePolls(FRIDGE_ID) > before) pollsAt.push(minute);
      }
      const gaps = pollsAt.slice(1).map((m, i) => m - pollsAt[i]);
      assert.deepEqual(gaps.slice(0, 5), [1, 2, 4, 8, 15]);
      assert.ok(gaps.every((g) => g * MINUTE <= MAX_DEVICE_BACKOFF_MS));
    });

    it("pauses all polling when ThinQ rate-limits the account", async () => {
      store.subscribe(FRIDGE_ID, 1);
      store.subscribe(DISHWASHER_ID, 1);
      const poller = newPoller();
      await poller.runCycle();

      fake.injectFault({ error: "EXCEEDED_API_CALLS" });
      clock += INTERVAL;
      const before = fake.requests.length;
      await poller.runCycle();
      assert.equal(fake.requests.length, before + 1, "stopped after the first refusal");

      const status = poller.status();
      assert.equal(status.state, "paused");
      assert.equal(status.resumesAt?.getTime(), clock + INTERVAL);
      assert.match(status.lastError ?? "", /1306/);
      assert.ok(logs.some((l) => l.level === "warn" && l.msg === "event polling paused"));

      clock += INTERVAL - 1;
      await poller.runCycle();
      assert.equal(fake.requests.length, before + 1, "no calls while paused");

      clock += 1;
      await poller.runCycle();
      assert.equal(fake.requests.length, before + 3, "both devices again");
      assert.equal(poller.status().state, "idle");
      assert.equal(poller.status().lastError, null);
    });

    it("doubles the pause up to 30 minutes while the problem lasts", async () => {
      store.subscribe(FRIDGE_ID, 1);
      fake.injectFault({ error: "EXCEEDED_API_CALLS", times: Infinity });
      const poller = newPoller();
      const pauses: number[] = [];
      for (let minute = 0; minute <= 180; minute++) {
        clock = START + minute * INTERVAL;
        const before = fake.requests.length;
        await poller.runCycle();
        if (fake.requests.length > before) pauses.push((poller.status().resumesAt!.getTime() - clock) / MINUTE);
      }
      assert.deepEqual(pauses.slice(0, 7), [1, 2, 4, 8, 16, 30, 30]);
      assert.ok(pauses.every((p) => p * MINUTE <= MAX_GLOBAL_BACKOFF_MS));
    });

    for (const error of ["INVALID_TOKEN", "INTERNAL_SERVER_ERROR", "INCORRECT_HEADER", "BAD_REQUEST"] as const) {
      it(`pauses all polling on ${error}`, async () => {
        store.subscribe(FRIDGE_ID, 1);
        store.subscribe(DISHWASHER_ID, 1);
        fake.injectFault({ error });
        const poller = newPoller();
        await poller.runCycle();
        assert.equal(fake.requests.length, 1);
        assert.equal(poller.status().state, "paused");
      });
    }

    it("pauses all polling when ThinQ can't be reached", async () => {
      store.subscribe(FRIDGE_ID, 1);
      store.subscribe(DISHWASHER_ID, 1);
      const unreachable = new ThinQClient({ accessToken: "t", countryCode: "US", clientId: "c", baseUrl: "http://127.0.0.1:9" });
      const poller = newPoller({ client: () => unreachable });
      await poller.runCycle();
      assert.equal(poller.status().state, "paused");
      assert.match(poller.status().lastError ?? "", /Could not reach/);
    });

    it("pauses, without throwing, when ThinQ is not configured", async () => {
      store.subscribe(FRIDGE_ID, 1);
      const poller = newPoller({
        client: () => {
          throw new ThinQConfigError("THINQ_ACCESS_TOKEN and THINQ_COUNTRY_CODE must be set");
        },
      });
      await poller.runCycle();
      assert.equal(poller.status().state, "paused");
      assert.match(poller.status().lastError ?? "", /THINQ_ACCESS_TOKEN/);
      assert.ok(logs.some((l) => l.level === "error" && l.msg === "event polling paused"));
      assert.equal(fake.requests.length, 0);
    });
  });

  describe("lifecycle", () => {
    const waitFor = async (check: () => boolean, what: string, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    it("polls on its interval once started, and stop() ends it", async () => {
      store.subscribe(FRIDGE_ID, 1);
      const poller = newPoller({ intervalMs: 30, now: Date.now });
      poller.start();
      poller.start(); // idempotent
      await waitFor(() => statePolls(FRIDGE_ID) >= 3, "three polls");
      await poller.stop();
      assert.equal(poller.status().state, "stopped");

      const count = statePolls(FRIDGE_ID);
      poller.trigger();
      poller.start();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(statePolls(FRIDGE_ID), count, "no polling after stop");
    });

    it("trigger() picks up a new subscription without waiting for the interval", async () => {
      const poller = newPoller({ intervalMs: 60_000, now: Date.now });
      poller.start();
      try {
        await new Promise((r) => setTimeout(r, 20)); // first (empty) cycle
        store.subscribe(FRIDGE_ID, 1);
        poller.trigger();
        await waitFor(() => subscription(FRIDGE_ID).lastPolledAt !== null, "baseline");
      } finally {
        await poller.stop();
      }
    });

    it("stop() waits for the cycle in flight", async () => {
      store.subscribe(FRIDGE_ID, 1);
      store.subscribe(DISHWASHER_ID, 1);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const slow = new HookedClient({ accessToken: "pat-test", countryCode: "US", clientId: "c", baseUrl: fake.url });
      const poller = newPoller({ client: () => slow });
      const first = new Promise<void>((resolve) => {
        slow.afterStatus = () => {
          resolve();
          return gate;
        };
      });
      const cycle = poller.runCycle();
      await first;
      let stopped = false;
      const stopping = poller.stop().then(() => (stopped = true));
      await new Promise((r) => setTimeout(r, 20));
      release();
      await Promise.all([cycle, stopping]);
      assert.ok(stopped);
      assert.equal(statePolls(), 1, "the second device was not polled after stop()");
    });

    it("rejects a nonsensical interval", () => {
      for (const intervalMs of [0, -1, NaN, Infinity]) assert.throws(() => newPoller({ intervalMs }), /intervalMs/);
    });
  });
});

describe("event store", () => {
  beforeEach(() => {
    db.delete(schema.events).run();
  });

  it("pages through history newest first, with filters", () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(store.recordEvent(bus, { deviceId: i % 2 ? FRIDGE_ID : DISHWASHER_ID, kind: i === 4 ? "control" : "event", payload: { i } }).id);
    }
    assert.deepEqual(store.queryEvents({ limit: 2 }).map((e) => e.id), [ids[4], ids[3]]);
    assert.deepEqual(store.queryEvents({ limit: 2, beforeId: ids[3] }).map((e) => e.id), [ids[2], ids[1]]);
    assert.deepEqual(store.queryEvents({ limit: 10, deviceId: FRIDGE_ID }).map((e) => e.id), [ids[3], ids[1]]);
    assert.deepEqual(store.queryEvents({ limit: 10, kind: "control" }).map((e) => e.id), [ids[4]]);
    assert.deepEqual(store.queryEvents({ limit: 10, afterId: ids[2] }).map((e) => e.id), [ids[3], ids[4]], "catch-up is oldest first");
    assert.deepEqual(store.queryEvents({ limit: 10, deviceId: "'; DROP TABLE events; --" }), []);
  });

  it("jumps to a page with an offset, and counts matching events", () => {
    const ids = Array.from({ length: 7 }, (_, i) => store.recordEvent(bus, { deviceId: i < 5 ? DISHWASHER_ID : FRIDGE_ID, kind: "event", payload: { i } }).id);
    assert.deepEqual(store.queryEvents({ limit: 3, offset: 3 }).map((e) => e.id), [ids[3], ids[2], ids[1]]);
    assert.deepEqual(store.queryEvents({ limit: 3, offset: 6 }).map((e) => e.id), [ids[0]]);
    assert.deepEqual(store.queryEvents({ limit: 3, offset: 7 }), []);
    // Pinned below an id, pages don't shift when new events arrive.
    const pinned = () => store.queryEvents({ limit: 2, offset: 2, beforeId: ids[6] + 1 }).map((e) => e.id);
    const before = pinned();
    store.recordEvent(bus, { deviceId: DISHWASHER_ID, kind: "event", payload: {} });
    assert.deepEqual(pinned(), before);

    assert.equal(store.countEvents({}), 8);
    assert.equal(store.countEvents({ deviceId: FRIDGE_ID }), 2);
    assert.equal(store.countEvents({ kind: "control" }), 0);
    assert.equal(store.countEvents({ beforeId: ids[6] + 1 }), 7);
    assert.equal(store.countEvents({ deviceId: DISHWASHER_ID, beforeId: ids[2] }), 2);
  });

  it("prunes old state-change events but keeps control records", () => {
    const old = new Date(START - 40 * 24 * 60 * MINUTE);
    store.recordEvent(bus, { deviceId: FRIDGE_ID, kind: "event", payload: { old: true }, createdAt: old });
    store.recordEvent(bus, { deviceId: FRIDGE_ID, kind: "control", payload: { old: true }, createdAt: old });
    store.recordEvent(bus, { deviceId: FRIDGE_ID, kind: "event", payload: { old: false }, createdAt: new Date(START - MINUTE) });

    const logs: string[] = [];
    const quiet: Logger = { info: (_o, m) => logs.push(m), warn: () => {}, error: () => {} };
    const stop = startRetention(30, quiet, () => START);
    stop();
    assert.deepEqual(
      store.queryEvents({ limit: 10 }).map((e) => [e.kind, e.payload.old]),
      [
        ["event", false],
        ["control", true],
      ],
    );
    assert.deepEqual(logs, ["pruned old device events"]);
  });
});
