/**
 * The SSE stream in-process, for the behaviours that are slow or awkward to
 * reach over HTTP: the replay cap, heartbeats re-checking the session, and
 * disconnecting clients that stop reading.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { ServerResponse } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "lg-home-streams-"));
process.env.DATABASE_PATH = join(dataDir, "test.db");
const { db, runMigrations, schema } = await import("../src/server/db/index.js");
const auth = await import("../src/server/auth.js");
const store = await import("../src/server/events/store.js");
const streams = await import("../src/server/events/streams.js");

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
  let user: { id: number; username: string };
  let token: string;

  before(() => {
    runMigrations();
    const now = new Date();
    const row = db.insert(schema.users).values({ username: "alice", passwordHash: "x", createdAt: now, updatedAt: now }).returning().get();
    user = { id: row.id, username: row.username };
  });
  after(() => {
    streams.closeAllStreams();
    rmSync(dataDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    streams.closeAllStreams();
    db.delete(schema.events).run();
    token = auth.createSession(user.id).token;
  });

  const record = (i: number) => store.recordEvent({ deviceId: "dev", kind: "event", payload: { i } });

  it("sends events live, as SSE frames with the event id", () => {
    const res = new FakeResponse();
    streams.serveStream(asResponse(res), { user, sessionToken: token });
    assert.equal(res.status, 200);
    assert.match(res.headers["Content-Type"], /^text\/event-stream/);
    const e = record(1);
    assert.ok(res.text.startsWith("retry: 5000\n\n"));
    assert.ok(res.text.endsWith(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`));
    assert.equal(streams.openStreamCount(), 1);
  });

  it("keeps event data on one line even when it contains newlines", () => {
    const res = new FakeResponse();
    streams.serveStream(asResponse(res), { user, sessionToken: token });
    store.recordEvent({ deviceId: "dev", kind: "event", payload: { evil: "x\n\nid: 999\ndata: {}\r\n" } });
    const frames = res.text.split("\n\n").filter(Boolean);
    assert.equal(frames.length, 2, "retry + one event");
    assert.equal(res.events[0].payload.evil, "x\n\nid: 999\ndata: {}\r\n");
  });

  it("replays up to the cap, and asks the client to reload beyond it", () => {
    const first = record(0);
    for (let i = 1; i <= streams.MAX_REPLAY; i++) record(i);

    const ok = new FakeResponse();
    streams.serveStream(asResponse(ok), { user, sessionToken: token, lastEventId: first.id });
    assert.equal(ok.events.length, streams.MAX_REPLAY);
    assert.ok(!ok.text.includes("event: reset"));

    const behind = new FakeResponse();
    streams.serveStream(asResponse(behind), { user, sessionToken: token, lastEventId: first.id - 1 });
    assert.equal(behind.events.length, 0);
    assert.match(behind.text, /event: reset\ndata: .*reload the history/);

    // Both carry on live, without repeating anything.
    const next = record(999);
    assert.deepEqual(ok.events.at(-1), JSON.parse(JSON.stringify(next)));
    assert.deepEqual(behind.events.map((e) => e.id), [next.id]);
  });

  it("sends heartbeats, and ends the stream at the first heartbeat after the session is gone", async () => {
    const res = new FakeResponse();
    streams.serveStream(asResponse(res), { user, sessionToken: token, heartbeatMs: 20 });
    await sleep(70);
    assert.match(res.text, /: ping\n\n/);
    assert.ok(!res.ended);

    auth.deleteUserSessions(user.id); // e.g. a password change in another process
    await sleep(50);
    assert.ok(res.ended);
    assert.equal(streams.openStreamCount(), 0);
  });

  it("ends the stream instead of sending an event once the session has expired", () => {
    const res = new FakeResponse();
    streams.serveStream(asResponse(res), { user, sessionToken: token });
    db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    record(1);
    assert.ok(res.ended);
    assert.deepEqual(res.events, []);
  });

  it("disconnects a client that stops reading", () => {
    const res = new FakeResponse(true);
    streams.serveStream(asResponse(res), { user, sessionToken: token });
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i < 40 && !res.ended; i++) store.recordEvent({ deviceId: "dev", kind: "event", payload: { big } });
    assert.ok(res.ended, "closed once more than MAX_BUFFERED_BYTES piled up");
    assert.ok(res.writableLength <= streams.MAX_BUFFERED_BYTES + 128 * 1024);
    assert.equal(streams.openStreamCount(), 0);
  });

  it("counts streams per user and in total", () => {
    assert.equal(streams.canOpenStream(user.id), null);
    for (let i = 0; i < streams.MAX_STREAMS_PER_USER; i++) {
      streams.serveStream(asResponse(new FakeResponse()), { user, sessionToken: token });
    }
    assert.equal(streams.canOpenStream(user.id), "user-limit");
    assert.equal(streams.canOpenStream(user.id + 1), null);

    for (let i = streams.MAX_STREAMS_PER_USER; i < streams.MAX_STREAMS_TOTAL; i++) {
      const other = { id: 1000 + i, username: `u${i}` };
      streams.serveStream(asResponse(new FakeResponse()), { user: other, sessionToken: `t${i}` });
    }
    assert.equal(streams.canOpenStream(user.id + 1), "global-limit");
    streams.closeAllStreams();
    assert.equal(streams.openStreamCount(), 0);
  });

  it("closes only the streams of the given session", () => {
    const other = auth.createSession(user.id).token;
    const a = new FakeResponse();
    const b = new FakeResponse();
    streams.serveStream(asResponse(a), { user, sessionToken: token });
    streams.serveStream(asResponse(b), { user, sessionToken: other });
    streams.closeStreamsForSession(token);
    streams.closeStreamsForSession(undefined);
    assert.ok(a.ended);
    assert.ok(!b.ended);
  });

  it("stops listening once a stream is closed by the client", () => {
    const res = new FakeResponse();
    streams.serveStream(asResponse(res), { user, sessionToken: token });
    res.emit("close");
    const before = res.text;
    record(1);
    assert.equal(res.text, before);
    assert.equal(streams.openStreamCount(), 0);
  });
});
