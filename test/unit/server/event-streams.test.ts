/**
 * The SSE stream in-process, for the behaviours that are slow or awkward to
 * reach over HTTP: the replay cap, heartbeats re-checking the session, and
 * disconnecting clients that stop reading.
 */
import { db, schema } from "../../helpers/test-db.js";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import type { ServerResponse } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import * as auth from "../../../src/server/auth.js";
import * as store from "../../../src/server/events/store.js";
import * as streams from "../../../src/server/events/streams.js";
import { EventBus } from "../../../src/server/events/bus.js";

/** A response that records what is written, or never drains when `stalled`. */
class FakeResponse extends Writable {
  status = 0;
  headers: Record<string, string> = {};
  text = "";
  constructor(stalled = false) {
    super({
      highWaterMark: 16 * 1024,
      write: (chunk: Buffer, _enc, callback) => {
        this.text += chunk.toString();
        if (!stalled) callback(); // a stalled client never acknowledges
      },
    });
  }
  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
    return this;
  }
  get ended() {
    return this.writableEnded;
  }
  /** Messages with data, parsed. */
  get events() {
    return this.text
      .split("\n\n")
      .filter((f) => f.includes("data: ") && !f.startsWith("event: "))
      .map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)));
  }
}

const asResponse = (r: FakeResponse) => r as unknown as ServerResponse;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("event streams", () => {
  // One app's bus and streams.
  const bus = new EventBus();
  const registry = new streams.StreamRegistry(bus);
  let user: { id: number; username: string };
  let token: string;

  before(() => {
    const now = new Date();
    const row = db.insert(schema.users).values({ username: "alice", passwordHash: "x", createdAt: now, updatedAt: now }).returning().get();
    user = { id: row.id, username: row.username };
  });
  after(() => registry.closeAll());
  beforeEach(() => {
    registry.closeAll();
    db.delete(schema.events).run();
    token = auth.createSession(user.id).token;
  });

  const record = (i: number) => store.recordEvent(bus, { deviceId: "dev", kind: "event", payload: { i } });

  it("sends events live, as SSE frames with the event id", () => {
    const res = new FakeResponse();
    registry.serve(asResponse(res), { user, sessionToken: token });
    assert.equal(res.status, 200);
    assert.match(res.headers["Content-Type"], /^text\/event-stream/);
    const e = record(1);
    assert.ok(res.text.startsWith("retry: 5000\n\n"));
    assert.ok(res.text.endsWith(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`));
    assert.equal(registry.size, 1);
  });

  it("keeps event data on one line even when it contains newlines", () => {
    const res = new FakeResponse();
    registry.serve(asResponse(res), { user, sessionToken: token });
    store.recordEvent(bus, { deviceId: "dev", kind: "event", payload: { evil: "x\n\nid: 999\ndata: {}\r\n" } });
    const frames = res.text.split("\n\n").filter(Boolean);
    assert.equal(frames.length, 2, "retry + one event");
    assert.equal(res.events[0].payload.evil, "x\n\nid: 999\ndata: {}\r\n");
  });

  it("replays up to the cap, and asks the client to reload beyond it", () => {
    const first = record(0);
    for (let i = 1; i <= streams.MAX_REPLAY; i++) record(i);

    const ok = new FakeResponse();
    registry.serve(asResponse(ok), { user, sessionToken: token, lastEventId: first.id });
    assert.equal(ok.events.length, streams.MAX_REPLAY);
    assert.ok(!ok.text.includes("event: reset"));

    const behind = new FakeResponse();
    registry.serve(asResponse(behind), { user, sessionToken: token, lastEventId: first.id - 1 });
    assert.equal(behind.events.length, 0);
    assert.match(behind.text, /event: reset\ndata: .*reload the history/);

    // Both carry on live, without repeating anything.
    const next = record(999);
    assert.deepEqual(ok.events.at(-1), JSON.parse(JSON.stringify(next)));
    assert.deepEqual(behind.events.map((e) => e.id), [next.id]);
  });

  it("sends heartbeats, and ends the stream at the first heartbeat after the session is gone", async () => {
    const res = new FakeResponse();
    registry.serve(asResponse(res), { user, sessionToken: token, heartbeatMs: 20 });
    await sleep(70);
    assert.match(res.text, /: ping\n\n/);
    assert.ok(!res.ended);

    auth.deleteUserSessions(user.id); // e.g. a password change in another process
    await sleep(50);
    assert.ok(res.ended);
    assert.equal(registry.size, 0);
  });

  it("ends the stream instead of sending an event once the session has expired", () => {
    const res = new FakeResponse();
    registry.serve(asResponse(res), { user, sessionToken: token });
    db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    record(1);
    assert.ok(res.ended);
    assert.deepEqual(res.events, []);
  });

  it("disconnects a client that stops reading", () => {
    const res = new FakeResponse(true);
    registry.serve(asResponse(res), { user, sessionToken: token });
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i < 40 && !res.ended; i++) store.recordEvent(bus, { deviceId: "dev", kind: "event", payload: { big } });
    assert.ok(res.ended, "closed once more than MAX_BUFFERED_BYTES piled up");
    assert.ok(res.writableLength <= streams.MAX_BUFFERED_BYTES + 128 * 1024);
    assert.equal(registry.size, 0);
  });

  it("counts streams per user and in total", () => {
    assert.equal(registry.canOpen(user.id), null);
    for (let i = 0; i < streams.MAX_STREAMS_PER_USER; i++) {
      registry.serve(asResponse(new FakeResponse()), { user, sessionToken: token });
    }
    assert.equal(registry.canOpen(user.id), "user-limit");
    assert.equal(registry.canOpen(user.id + 1), null);

    for (let i = streams.MAX_STREAMS_PER_USER; i < streams.MAX_STREAMS_TOTAL; i++) {
      const other = { id: 1000 + i, username: `u${i}` };
      registry.serve(asResponse(new FakeResponse()), { user: other, sessionToken: `t${i}` });
    }
    assert.equal(registry.canOpen(user.id + 1), "global-limit");
    registry.closeAll();
    assert.equal(registry.size, 0);
  });

  it("closes only the streams of the given session", () => {
    const other = auth.createSession(user.id).token;
    const a = new FakeResponse();
    const b = new FakeResponse();
    registry.serve(asResponse(a), { user, sessionToken: token });
    registry.serve(asResponse(b), { user, sessionToken: other });
    registry.closeForSession(token);
    registry.closeForSession(undefined);
    assert.ok(a.ended);
    assert.ok(!b.ended);
  });

  it("stops listening once a stream is closed by the client", () => {
    const res = new FakeResponse();
    registry.serve(asResponse(res), { user, sessionToken: token });
    res.emit("close");
    const before = res.text;
    record(1);
    assert.equal(res.text, before);
    assert.equal(registry.size, 0);
  });
});

describe("one app's events and streams are its own", () => {
  let user: { id: number; username: string };
  let token: string;
  const busA = new EventBus();
  const busB = new EventBus();
  const appA = new streams.StreamRegistry(busA);
  const appB = new streams.StreamRegistry(busB);

  before(() => {
    const now = new Date();
    const row = db.insert(schema.users).values({ username: "bob", passwordHash: "x", createdAt: now, updatedAt: now }).returning().get();
    user = { id: row.id, username: row.username };
  });
  beforeEach(() => {
    appA.closeAll();
    appB.closeAll();
    token = auth.createSession(user.id).token;
  });
  after(() => {
    appA.closeAll();
    appB.closeAll();
  });

  it("an event stored by one app is delivered only to that app's streams", () => {
    const a = new FakeResponse();
    const b = new FakeResponse();
    appA.serve(asResponse(a), { user, sessionToken: token });
    appB.serve(asResponse(b), { user, sessionToken: token });
    const e = store.recordEvent(busA, { deviceId: "dev", kind: "control", payload: { x: 1 } });
    assert.deepEqual(a.events.map((ev) => ev.id), [e.id]);
    assert.deepEqual(b.events, []);
  });

  it("closing one app's streams (shutdown) leaves the other app's open", () => {
    const a = new FakeResponse();
    const b = new FakeResponse();
    appA.serve(asResponse(a), { user, sessionToken: token });
    appB.serve(asResponse(b), { user, sessionToken: token });
    appA.closeAll();
    assert.equal(a.ended, true);
    assert.equal(b.ended, false);
    assert.equal(appA.size, 0);
    assert.equal(appB.size, 1);
    assert.equal(busA.listenerCount, 0, "a closed stream stops listening");
    assert.equal(busB.listenerCount, 1);
  });

  it("closing a session's streams in one app (logout) leaves the other app's", () => {
    const a = new FakeResponse();
    const b = new FakeResponse();
    appA.serve(asResponse(a), { user, sessionToken: token });
    appB.serve(asResponse(b), { user, sessionToken: token });
    appA.closeForSession(token);
    assert.equal(a.ended, true);
    assert.equal(b.ended, false);
  });

  it("stream limits are counted per app", () => {
    for (let i = 0; i < streams.MAX_STREAMS_PER_USER; i++) appA.serve(asResponse(new FakeResponse()), { user, sessionToken: token });
    assert.equal(appA.canOpen(user.id), "user-limit");
    assert.equal(appB.canOpen(user.id), null);
  });
});

describe("EventBus", () => {
  const event = { id: 1, deviceId: "d", kind: "event", payload: {}, createdAt: new Date() };

  it("delivers to every listener, even when one of them throws", () => {
    const bus = new EventBus();
    const got: string[] = [];
    bus.on(() => got.push("first"));
    bus.on(() => {
      throw new Error("broken listener");
    });
    bus.on(() => got.push("third"));
    assert.doesNotThrow(() => bus.publish(event));
    assert.deepEqual(got, ["first", "third"]);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new EventBus();
    let calls = 0;
    const off = bus.on(() => calls++);
    bus.publish(event);
    off();
    bus.publish(event);
    assert.equal(calls, 1);
    assert.equal(bus.listenerCount, 0);
  });
});
