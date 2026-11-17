/** The live event stream provider and how live events land in the query cache. */
import "../../helpers/dom.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { setUnauthorizedHandler } from "../../../src/web/api.js";
import {
  MAX_EVENT_OFFSET,
  applyLiveEvent,
  eventCountKey,
  eventPageKey,
  eventsKey,
  pageCount,
  pageItems,
  prependEvent,
  prependToPage,
  useEventHistory,
  type EventPage,
} from "../../../src/web/events/cache.js";
import { EventStreamProvider, useStreamStatus } from "../../../src/web/events/stream.js";
import { queryKeys } from "../../../src/web/queries.js";
import { DW, FRIDGE, FakeBackend, FakeEventSource, controlEvent, fakeEventSource, newQueryClient, renderWithClient, stateEvent } from "../../helpers/fake-backend.js";

const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

function Probe() {
  const status = useStreamStatus();
  const history = useEventHistory({});
  return (
    <div>
      <p data-testid="status">{status}</p>
      <ol>{history.data?.pages.flat().map((e) => <li key={e.id}>event {e.id}</li>)}</ol>
    </div>
  );
}

describe("event cache", () => {
  it("prepends newer events only, once", () => {
    const data = { pages: [[stateEvent(5, DW, "a.b", 1, 2)], [stateEvent(3, DW, "a.b", 0, 1)]], pageParams: [undefined, 5] };
    const next = prependEvent(data, stateEvent(6, DW, "a.b", 2, 3))!;
    assert.deepEqual(next.pages.map((p) => p.map((e) => e.id)), [[6, 5], [3]]);
    assert.equal(prependEvent(next, stateEvent(6, DW, "a.b", 2, 3)), next, "duplicate");
    assert.equal(prependEvent(next, stateEvent(4, DW, "a.b", 2, 3)), next, "older: left to the history");
    assert.equal(prependEvent(undefined, stateEvent(1, DW, "a.b", 1, 2)), undefined);
    const empty = { pages: [[]], pageParams: [undefined] };
    assert.deepEqual(prependEvent(empty, stateEvent(1, DW, "a.b", 1, 2))!.pages[0].map((e) => e.id), [1]);
  });

  it("adds a live event to every cached list it matches, and no other", () => {
    const qc = newQueryClient();
    const seed = { pages: [[]], pageParams: [undefined] };
    for (const filter of [{}, { deviceId: DW }, { deviceId: FRIDGE }, { kind: "event" as const }, { kind: "control" as const }]) {
      qc.setQueryData(eventsKey(filter, 50), seed);
    }
    applyLiveEvent(qc, stateEvent(1, DW, "runState.currentState", "INITIAL", "RUNNING"));
    const ids = (filter: object) => (qc.getQueryData(eventsKey(filter, 50)) as typeof seed).pages[0].length;
    assert.deepEqual([ids({}), ids({ deviceId: DW }), ids({ deviceId: FRIDGE }), ids({ kind: "event" }), ids({ kind: "control" })], [1, 1, 0, 1, 0]);
  });

  it("puts a live event on top of the live first page, keeping its size", () => {
    const page = { events: [stateEvent(5, DW, "a.b", 1, 2), stateEvent(4, DW, "a.b", 0, 1)], total: 9 };
    const next = prependToPage(page, stateEvent(6, DW, "a.b", 2, 3), 2)!;
    assert.deepEqual(next.events.map((e) => e.id), [6, 5]);
    assert.equal(next.total, 10);
    assert.equal(prependToPage(next, stateEvent(6, DW, "a.b", 2, 3), 2), next, "duplicate");
    assert.equal(prependToPage(next, stateEvent(3, DW, "a.b", 2, 3), 2), next, "older");
    assert.equal(prependToPage(undefined, stateEvent(1, DW, "a.b", 1, 2), 2), undefined);
    assert.deepEqual(prependToPage({ events: [], total: 0 }, stateEvent(1, DW, "a.b", 1, 2), 2), { events: [stateEvent(1, DW, "a.b", 1, 2)], total: 1 });
  });

  it("updates the live first page and counts, but never a pinned page", () => {
    const qc = newQueryClient();
    const seed = (): EventPage => ({ events: [stateEvent(1, DW, "a.b", 0, 1)], total: 1 });
    const live = eventPageKey({ pageSize: 25, page: 1, before: null });
    const pinnedFirst = eventPageKey({ pageSize: 25, page: 1, before: 2 });
    const second = eventPageKey({ pageSize: 25, page: 2, before: 2 });
    const fridgeOnly = eventPageKey({ deviceId: FRIDGE, pageSize: 25, page: 1, before: null });
    for (const key of [live, pinnedFirst, second, fridgeOnly]) qc.setQueryData(key, seed());
    qc.setQueryData(eventCountKey({}), 1);
    qc.setQueryData(eventCountKey({ kind: "control" }), 0);

    applyLiveEvent(qc, stateEvent(2, DW, "a.b", 1, 2));
    const ids = (key: readonly unknown[]) => qc.getQueryData<EventPage>(key)!.events.map((e) => e.id);
    assert.deepEqual(ids(live), [2, 1]);
    assert.equal(qc.getQueryData<EventPage>(live)!.total, 2);
    assert.deepEqual(ids(pinnedFirst), [1]);
    assert.deepEqual(ids(second), [1]);
    assert.deepEqual(ids(fridgeOnly), [1]);
    assert.equal(qc.getQueryData(eventCountKey({})), 2);
    assert.equal(qc.getQueryData(eventCountKey({ kind: "control" })), 0);
  });

  it("lists the page buttons to show", () => {
    assert.deepEqual(pageItems(1, 1), [1]);
    assert.deepEqual(pageItems(1, 3), [1, 2, 3]);
    assert.deepEqual(pageItems(1, 10), [1, 2, "gap", 10]);
    assert.deepEqual(pageItems(4, 10), [1, 2, 3, 4, 5, "gap", 10], "a one-page gap is filled in");
    assert.deepEqual(pageItems(6, 12), [1, "gap", 5, 6, 7, "gap", 12]);
    assert.deepEqual(pageItems(10, 10), [1, "gap", 9, 10]);
    assert.deepEqual(pageItems(8, 10), [1, "gap", 7, 8, 9, 10]);
  });

  it("counts pages, within what the server can reach", () => {
    assert.equal(pageCount(0, 25), 1);
    assert.equal(pageCount(25, 25), 1);
    assert.equal(pageCount(26, 25), 2);
    assert.equal(pageCount(10_000_000, 100), MAX_EVENT_OFFSET / 100 + 1);
  });

  it("merges state changes into a cached status, without creating one", () => {
    const qc = newQueryClient();
    qc.setQueryData(queryKeys.status(DW), { runState: { currentState: "INITIAL" }, timer: { remainMinute: 0 } });
    applyLiveEvent(qc, stateEvent(1, DW, "runState.currentState", "INITIAL", "RUNNING"));
    assert.deepEqual(qc.getQueryData(queryKeys.status(DW)), { runState: { currentState: "RUNNING" }, timer: { remainMinute: 0 } });

    applyLiveEvent(qc, stateEvent(2, FRIDGE, "powerSave.powerSaveEnabled", false, true));
    assert.equal(qc.getQueryData(queryKeys.status(FRIDGE)), undefined);

    // Commands are what was asked for, not what happened: they don't touch the status.
    applyLiveEvent(qc, controlEvent(3, DW, { runState: { currentState: "BOGUS" } }));
    assert.deepEqual(qc.getQueryData(queryKeys.status(DW)), { runState: { currentState: "RUNNING" }, timer: { remainMinute: 0 } });
  });
});

describe("event stream provider", () => {
  let backend: FakeBackend;
  let unauthorized: number;

  beforeEach(() => {
    backend = new FakeBackend();
    FakeEventSource.reset();
    unauthorized = 0;
    setUnauthorizedHandler(() => unauthorized++);
  });
  afterEach(() => {
    cleanup();
    backend.restore();
  });

  const mount = (retryDelaysMs = [20, 60]) =>
    renderWithClient(
      <EventStreamProvider createEventSource={fakeEventSource} retryDelaysMs={retryDelaysMs}>
        <Probe />
      </EventStreamProvider>,
    );
  const status = () => screen.getByTestId("status").textContent;

  it("opens one stream to the server and reports its state", async () => {
    mount();
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(FakeEventSource.latest.url, "/api/events/stream");
    assert.equal(status(), "connecting");
    FakeEventSource.latest.open();
    assert.equal(status(), "open");
  });

  it("shows live events in mounted lists", async () => {
    backend.events = [stateEvent(1, DW, "a.b", 1, 2)];
    mount();
    await screen.findByText("event 1");
    FakeEventSource.latest.open();
    FakeEventSource.latest.send(stateEvent(2, DW, "a.b", 2, 3));
    await screen.findByText("event 2");
    assert.deepEqual(screen.getAllByRole("listitem").map((li) => li.textContent), ["event 2", "event 1"]);
  });

  it("ignores malformed messages", async () => {
    mount();
    await waitFor(() => assert.equal(backend.count("GET", "/api/events"), 1));
    FakeEventSource.latest.open();
    for (const junk of ["", "not json", '{"id":"x"}', "null", '{"id":1,"kind":"event","payload":{},"createdAt":"nope","deviceId":null}']) {
      FakeEventSource.latest.send(junk);
    }
    assert.equal(screen.queryAllByRole("listitem").length, 0);
    assert.equal(status(), "open");
  });

  it("reloads the history when the server says too much was missed", async () => {
    mount();
    await waitFor(() => assert.equal(backend.count("GET", "/api/events"), 1));
    FakeEventSource.latest.sendNamed("reset", { reason: "too many missed events" });
    await waitFor(() => assert.equal(backend.count("GET", "/api/events"), 2));
  });

  it("lets the browser reconnect a dropped connection by itself", async () => {
    mount();
    FakeEventSource.latest.open();
    FakeEventSource.latest.drop();
    assert.equal(status(), "reconnecting");
    await sleep(100);
    assert.equal(FakeEventSource.instances.length, 1, "no second EventSource");
    assert.equal(backend.count("GET", "/api/auth/me"), 0);
    FakeEventSource.latest.open();
    assert.equal(status(), "open");
  });

  it("returns to the login page when the stream was refused because the session ended", async () => {
    mount();
    FakeEventSource.latest.open();
    backend.user = null;
    FakeEventSource.latest.fail();
    assert.equal(status(), "closed");
    await waitFor(() => assert.equal(unauthorized, 1));
    assert.ok(FakeEventSource.latest.closed);
    await sleep(150);
    assert.equal(FakeEventSource.instances.length, 1, "no reconnect without a session");
  });

  it("reconnects with a growing delay while signed in, then reloads the history", async () => {
    mount([30, 120]);
    FakeEventSource.latest.open();
    await waitFor(() => assert.equal(backend.count("GET", "/api/events"), 1));

    FakeEventSource.latest.fail();
    await waitFor(() => assert.equal(FakeEventSource.instances.length, 2));
    assert.equal(status(), "reconnecting");
    assert.ok(FakeEventSource.instances[0].closed);

    FakeEventSource.latest.fail(); // still failing: wait longer this time
    await sleep(60);
    assert.equal(FakeEventSource.instances.length, 2, "second retry waits longer");
    await waitFor(() => assert.equal(FakeEventSource.instances.length, 3));

    FakeEventSource.latest.open();
    assert.equal(status(), "open");
    await waitFor(() => assert.equal(backend.count("GET", "/api/events"), 2)); // missed events reloaded
    assert.equal(unauthorized, 0);
  });

  it("retries when the session check itself fails", async () => {
    mount();
    backend.fail("GET /api/auth/me", 500, "boom");
    FakeEventSource.latest.fail();
    await waitFor(() => assert.equal(FakeEventSource.instances.length, 2));
    assert.equal(unauthorized, 0);
  });

  it("closes the stream and cancels retries when unmounted", async () => {
    const view = mount([30]);
    const first = FakeEventSource.latest;
    first.open();
    view.unmount();
    assert.ok(first.closed);

    // Unmount while a reconnect is scheduled (session checked, timer pending).
    const again = mount([150]);
    FakeEventSource.latest.fail();
    await waitFor(() => assert.ok(backend.count("GET", "/api/auth/me") >= 1));
    await sleep(30);
    again.unmount();
    await sleep(250);
    assert.equal(FakeEventSource.instances.length, 2, "no reconnect after unmount");
  });
});
