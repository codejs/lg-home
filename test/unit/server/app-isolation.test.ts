/**
 * Each app built with buildApp has its own event bus and event streams: two
 * apps in one process (sharing the database) don't see each other's live
 * events, and closing one ends only its own streams. Real HTTP on local ports,
 * in-process.
 */
import { resetDb } from "../../helpers/test-db.js";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildTestApp, createUser, login } from "../../helpers/app.js";
import { eventData, openEventStream, type EventStream } from "../../helpers/app-server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("apps in one process are isolated", () => {
  let appA: FastifyInstance;
  let appB: FastifyInstance;
  let cookie: string;
  let urlA: string;
  let urlB: string;
  const opened: EventStream[] = [];

  const stream = async (base: string) => {
    const s = await openEventStream(`${base}/api/events/stream`, { cookie });
    assert.equal(s.status, 200);
    opened.push(s);
    return s;
  };
  const control = (base: string, enabled: boolean) =>
    fetch(`${base}/api/devices/d1/control`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ powerSave: { powerSaveEnabled: enabled } }),
    });

  before(async () => {
    resetDb();
    await createUser("alice", "secret123");
    const a = await buildTestApp();
    const b = await buildTestApp();
    [appA, appB] = [a.app, b.app];
    for (const { thinq } of [a, b]) thinq.devices = [{ deviceId: "d1", deviceInfo: { deviceType: "DEVICE_REFRIGERATOR", alias: "Fridge" } }];
    urlA = await appA.listen({ port: 0, host: "127.0.0.1" });
    urlB = await appB.listen({ port: 0, host: "127.0.0.1" });
    // One login works for both: they share the database.
    cookie = await login(appA);
    assert.equal((await appA.inject({ method: "POST", url: "/api/devices/sync", headers: { cookie } })).statusCode, 200);
  });

  after(async () => {
    for (const s of opened) s.close();
    await appA?.close();
    await appB?.close();
  });

  it("a command sent through one app is streamed live only by that app", async () => {
    const [a, b] = [await stream(urlA), await stream(urlB)];
    assert.equal((await control(urlA, true)).status, 200);
    const event = eventData(await a.next((m) => m.data !== undefined, "app A's event"));
    assert.equal(event.kind, "control");
    await sleep(200);
    assert.equal(b.messages.filter((m) => m.data !== undefined).length, 0, "app B saw nothing");
  });

  it("closing one app ends its streams only; the other keeps streaming", async () => {
    const [a, b] = [await stream(urlA), await stream(urlB)];
    await appA.close();
    await a.ended; // ended by app A's shutdown
    assert.equal((await control(urlB, false)).status, 200);
    const event = eventData(await b.next((m) => m.data !== undefined, "app B's event after A closed"));
    assert.deepEqual(event.payload, { powerSave: { powerSaveEnabled: false } });
  });
});
