/**
 * The events UI, driven like a user would: the device cards and the events
 * panel below them (watching a device, its latest events, live status), the Events tab
 * (filters, paging, live updates, connection state) and the event list.
 */
import "../../helpers/dom.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DevicesPage } from "../../../src/web/DevicesPage.js";
import { EventList } from "../../../src/web/EventList.js";
import {
  DW,
  FRIDGE,
  FakeBackend,
  FakeEventSource,
  controlEvent,
  fakeEventSource,
  iso,
  renderWithClient,
  stateEvent,
} from "../../helpers/fake-backend.js";
import { setBrowserLanguages } from "../../helpers/locale.js";

const user = { id: 1, username: "alice" };

let backend: FakeBackend;
beforeEach(() => {
  backend = new FakeBackend();
  FakeEventSource.reset();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  backend.restore();
});

const renderApp = () => renderWithClient(<DevicesPage user={user} createEventSource={fakeEventSource} />);
const deviceCard = (name: string) => screen.getByRole("article", { name });
/** The status pill on a device's card ("Ready", "Running", ...), once loaded. */
const statusPill = (name: string) => deviceCard(name).querySelector(".status-pill")?.textContent;
const eventsButton = (name: string) => screen.getByRole("button", { name: `Events for ${name}` });
const eventItems = () => within(screen.getByRole("list", { name: "Device events" })).getAllByRole("listitem").filter((li) => li.classList.contains("event"));

/** Open a device's events panel from its card. */
async function openDevice(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Events for ${name}` }));
  return screen.findByRole("region", { name: `Events for ${name}` });
}

describe("EventList", () => {
  it("summarises each event with its type, device and time", () => {
    const aliases = new Map([[DW, "Dishwasher"]]);
    renderWithClient(
      <EventList
        events={[stateEvent(2, DW, "runState.currentState", "RUNNING", "END"), controlEvent(1, "gone", { operation: { mode: "START" } })]}
        aliases={aliases}
      />,
    );
    const [state, command] = screen.getAllByRole("listitem").filter((li) => li.classList.contains("event"));
    assert.match(state.textContent!, /State.*Dishwasher.*State changed/);
    assert.ok(within(state).getByText("Status: Running → Finished"));
    assert.equal(state.querySelector("time")!.getAttribute("datetime"), iso(2));
    assert.match(command.textContent!, /Command.*gone.*Command sent/, "unknown devices fall back to the id");
    assert.ok(within(command).getByText("Operation › Mode: Start"));
  });

  it("shows readable lines and keeps the device's own names in a tooltip", () => {
    renderWithClient(
      <EventList
        events={[
          stateEvent(2, DW, "doorStatus[FRIDGE].doorState", "CLOSE", "OPEN"),
          controlEvent(1, FRIDGE, { temperature: { locationName: "FREEZER", targetTemperature: -21, unit: "C" } }),
        ]}
      />,
    );
    const line = (text: string) => screen.getByText(text).closest("li")!;
    assert.equal(line("Fridge · Door: Closed → Open").title, "doorStatus[FRIDGE].doorState: CLOSE → OPEN");
    assert.equal(
      line("Freezer · Target temperature: −21 °C").title,
      "temperature[FREEZER].targetTemperature = -21; temperature[FREEZER].unit = C",
    );
    assert.equal(document.querySelector(".event-lines code"), null, "plain text, not code");
  });

  it("keeps the full payload behind Details", async () => {
    renderWithClient(<EventList events={[stateEvent(1, DW, "a.b", 1, 2)]} />);
    const details = screen.getByText("Details").closest("details")!;
    assert.equal(details.open, false);
    await userEvent.click(screen.getByText("Details"));
    assert.equal(details.open, true);
    assert.match(details.querySelector("pre")!.textContent!, /"source": "poll"/);
  });

  it("hides the device column when asked, and shows an empty message", () => {
    const { unmount } = renderWithClient(<EventList events={[stateEvent(1, DW, "a.b", 1, 2)]} showDevice={false} />);
    assert.equal(document.querySelector(".event-device"), null);
    unmount();
    renderWithClient(<EventList events={[]} emptyText="Nothing here." />);
    assert.ok(screen.getByText("Nothing here."));
  });

  it("says how many more values changed than are shown", () => {
    const e = stateEvent(1, DW, "a.b", 1, 2);
    e.payload.changes = Array.from({ length: 8 }, (_, i) => ({ path: `r.p${i}`, from: 0, to: 1 }));
    renderWithClient(<EventList events={[e]} />);
    assert.ok(screen.getByText("+2 more"));
  });

  it("renders event data as text, never as markup", () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    const e = stateEvent(1, DW, "a.b", evil, evil);
    e.payload.changes = [{ path: `x.${evil}`, from: evil, to: evil }];
    renderWithClient(<EventList events={[e]} aliases={new Map([[DW, evil]])} />);
    assert.equal(document.querySelector("img"), null);
    assert.equal(document.querySelector(".events script"), null);
    assert.equal((window as unknown as { __pwned?: number }).__pwned, undefined);
    assert.ok(screen.getByText(evil, { selector: "strong" }));
  });
});

describe("devices tab", () => {
  it("marks watched devices", async () => {
    backend.subscribe(DW);
    renderApp();
    await waitFor(() => assert.ok(within(deviceCard("Dishwasher")).getByText("Watching")));
    assert.equal(within(deviceCard("Kitchen Fridge")).queryByText("Watching"), null);
    // The badge shares the name's line (in the flow, so long names wrap instead of overlapping it),
    // but is not part of the heading that names the card.
    const head = within(deviceCard("Dishwasher")).getByText("Watching").parentElement!;
    assert.ok(head.classList.contains("device-card-name"));
    assert.equal(head.querySelector("h2")!.textContent, "Dishwasher");
  });

  it("opens a device's events panel below all the cards, one device at a time", async () => {
    renderApp();
    await screen.findByRole("article", { name: "Dishwasher" });
    assert.equal(screen.queryByRole("region", { name: /^Events for/ }), null, "closed until asked for");
    assert.equal(eventsButton("Dishwasher").getAttribute("aria-expanded"), "false");

    const panel = await openDevice("Dishwasher");
    const grid = screen.getByRole("list", { name: "Devices" });
    assert.ok(grid.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING, "the panel follows the grid");
    assert.equal(grid.contains(panel), false, "and is not inside a card");
    assert.equal(eventsButton("Dishwasher").getAttribute("aria-expanded"), "true");
    assert.equal(eventsButton("Dishwasher").getAttribute("aria-controls"), panel.id);
    assert.ok(deviceCard("Dishwasher").classList.contains("selected"));

    await openDevice("Kitchen Fridge");
    assert.equal(screen.queryByRole("region", { name: "Events for Dishwasher" }), null, "one panel at a time");
    assert.equal(eventsButton("Dishwasher").getAttribute("aria-expanded"), "false");
    assert.ok(!deviceCard("Dishwasher").classList.contains("selected"));
    assert.ok(deviceCard("Kitchen Fridge").classList.contains("selected"));

    await userEvent.click(eventsButton("Kitchen Fridge"));
    await waitFor(() => assert.equal(screen.queryByRole("region", { name: /^Events for/ }), null, "pressing it again closes it"));
    assert.ok(!deviceCard("Kitchen Fridge").classList.contains("selected"));
  });

  it("shows every device's live status on its card without opening anything", async () => {
    renderApp();
    await waitFor(() => assert.equal(statusPill("Dishwasher"), "Ready"));
    assert.equal(backend.count("GET", `/api/devices/${DW}/status`), 1);
    assert.equal(backend.count("GET", `/api/devices/${FRIDGE}/status`), 1);
    assert.equal(backend.count("GET", "/api/events"), 0, "no event history until a panel is opened");
  });

  it("watches a device and stops watching it", async () => {
    renderApp();
    const panel = await openDevice("Kitchen Fridge");
    await within(panel).findByText(/Not watched/);

    await userEvent.click(within(panel).getByRole("button", { name: "Watch state changes" }));
    await within(panel).findByRole("button", { name: "Stop watching" });
    assert.equal(backend.count("PUT", `/api/devices/${FRIDGE}/subscription`), 1);
    assert.ok(within(panel).getByText(/Watching since .* \(by alice\)\. Waiting for the first check\./));
    await waitFor(() => assert.ok(within(deviceCard("Kitchen Fridge")).getByText("Watching")));

    await userEvent.click(within(panel).getByRole("button", { name: "Stop watching" }));
    await within(panel).findByRole("button", { name: "Watch state changes" });
    assert.equal(backend.count("DELETE", `/api/devices/${FRIDGE}/subscription`), 1);
    await waitFor(() => assert.equal(within(deviceCard("Kitchen Fridge")).queryByText("Watching"), null));
  });

  it("uses the accent style only for the call to action", async () => {
    backend.subscribe(DW);
    renderApp();
    let panel = await openDevice("Kitchen Fridge");
    assert.ok((await within(panel).findByRole("button", { name: "Watch state changes" })).classList.contains("primary"));
    panel = await openDevice("Dishwasher");
    assert.ok(!(await within(panel).findByRole("button", { name: "Stop watching" })).classList.contains("primary"));
  });

  it("shows why watching failed, and stays unwatched", async () => {
    backend.fail(`PUT /api/devices/${FRIDGE}/subscription`, 502, "ThinQ API error 429 (code 1306)");
    renderApp();
    const panel = await openDevice("Kitchen Fridge");
    await userEvent.click(await within(panel).findByRole("button", { name: "Watch state changes" }));
    await within(panel).findByText("ThinQ API error 429 (code 1306)");
    assert.ok(within(panel).getByRole("button", { name: "Watch state changes" }));
  });

  it("shows when a device was last checked, its last error, and a paused poller", async () => {
    backend.subscribe(DW, { lastChangeAt: iso(3), lastError: "ThinQ API error 400 (code 1222): Device is not connected", lastErrorAt: iso(4) });
    backend.poller = { ...backend.poller, state: "paused", resumesAt: iso(10), lastError: "ThinQ API error 429 (code 1306)" };
    renderApp();
    const panel = await openDevice("Dishwasher");
    await within(panel).findByText(/Last checked .*\. Last change /);
    assert.ok(within(panel).getByText(/Last check failed .*code 1222.*not connected/));
    assert.ok(within(panel).getByRole("status").textContent!.match(/paused until .*: ThinQ API error 429 \(code 1306\)/));
  });

  it("lists the device's latest events and updates them and the status live", async () => {
    backend.subscribe(DW);
    backend.events = [
      ...Array.from({ length: 6 }, (_, i) => stateEvent(i + 1, DW, "timer.remainMinute", 60 - i, 59 - i)),
      stateEvent(7, FRIDGE, "powerSave.powerSaveEnabled", false, true),
    ];
    renderApp();
    const panel = await openDevice("Dishwasher");
    await waitFor(() => assert.equal(eventItems().length, 5)); // the five latest
    assert.ok(within(panel).getByText("Timer › Time left (min): 55 → 54"));
    assert.equal(within(panel).queryByText("Timer › Time left (min): 60 → 59"), null);
    assert.equal(within(panel).queryByText(/Power save/), null, "other devices' events are not listed");

    const card = deviceCard("Dishwasher");
    await waitFor(() => assert.equal(statusPill("Dishwasher"), "Ready"));
    const raw = within(card).getByText(/"currentState": "INITIAL"/);
    const statusFetches = backend.count("GET", `/api/devices/${DW}/status`);
    FakeEventSource.latest.open();
    FakeEventSource.latest.send(stateEvent(8, DW, "runState.currentState", "INITIAL", "RUNNING"));

    await within(panel).findByText("Status: Ready → Running");
    assert.equal(eventItems().length, 5);
    // The card's status follows the event too.
    await waitFor(() => assert.equal(statusPill("Dishwasher"), "Running"));
    assert.match(raw.textContent!, /"currentState": "RUNNING"/);
    assert.equal(backend.count("GET", `/api/devices/${DW}/status`), statusFetches, "no extra ThinQ call");
  });

  it("opens the Events tab filtered to the device", async () => {
    backend.events = [stateEvent(1, DW, "a.b", 1, 2), stateEvent(2, FRIDGE, "c.d", 1, 2)];
    renderApp();
    const panel = await openDevice("Dishwasher");
    await userEvent.click(await within(panel).findByRole("button", { name: "Show all events" }));
    const page = await screen.findByRole("region", { name: "Events" });
    assert.equal((within(page).getByLabelText("Device") as HTMLSelectElement).value, DW);
    await waitFor(() => assert.equal(eventItems().length, 1));
    assert.equal(window.location.hash, "#events");
  });
});

describe("times", () => {
  const AM_PM = /\s[AP]M\b/;
  for (const [language, twelveHour] of [
    ["en-US", true],
    ["en-GB", false],
  ] as const) {
    it(`card, events panel and event list all use the browser's locale (${language})`, async () => {
      const restore = setBrowserLanguages(language);
      try {
        backend.subscribe(DW);
        backend.events = [stateEvent(1, DW, "a.b", 1, 2)];
        renderApp();
        const panel = await openDevice("Dishwasher");
        const updated = () => deviceCard("Dishwasher").querySelector(".device-card-footer .muted")?.textContent ?? "";
        await waitFor(() => assert.match(updated(), /^Updated \d/));
        const watching = (await within(panel).findByText(/Watching since/)).textContent!;
        const eventTime = await waitFor(() => {
          const time = panel.querySelector(".event time");
          assert.ok(time, "the event is listed");
          return time.textContent!;
        });
        for (const [what, text] of [
          ["card", updated()],
          ["panel", watching],
          ["event", eventTime],
        ]) {
          if (twelveHour) assert.match(text, AM_PM, `${what}: ${text}`);
          else assert.doesNotMatch(text, AM_PM, `${what}: ${text}`);
        }
      } finally {
        restore();
      }
    });
  }
});

describe("tabs", () => {
  it("switches between devices and events, keeping the tab in the URL", async () => {
    renderApp();
    const devicesTab = screen.getByRole("button", { name: "Devices" });
    const eventsTab = screen.getByRole("button", { name: "Events" });
    assert.equal(devicesTab.getAttribute("aria-current"), "page");
    assert.ok(devicesTab.classList.contains("active"));

    await userEvent.click(eventsTab);
    assert.equal(window.location.hash, "#events");
    assert.equal(eventsTab.getAttribute("aria-current"), "page");
    assert.equal(devicesTab.getAttribute("aria-current"), null);
    assert.ok(await screen.findByLabelText("Type"));

    act(() => {
      window.history.back();
    });
    await waitFor(() => assert.equal(devicesTab.getAttribute("aria-current"), "page"));
  });

  it("opens on the Events tab from #events", async () => {
    window.history.replaceState(null, "", "/#events");
    renderApp();
    assert.equal(screen.getByRole("button", { name: "Events" }).getAttribute("aria-current"), "page");
    assert.ok(await screen.findByLabelText("Device"));
  });

  it("keeps one event stream across tabs", async () => {
    renderApp();
    await userEvent.click(screen.getByRole("button", { name: "Events" }));
    await userEvent.click(screen.getByRole("button", { name: "Devices" }));
    assert.equal(FakeEventSource.instances.filter((s) => !s.closed).length, 1);
  });
});

describe("events tab", () => {
  beforeEach(() => window.history.replaceState(null, "", "/#events"));

  it("lists all events newest first, with device names", async () => {
    backend.events = [stateEvent(1, DW, "a.b", 1, 2), controlEvent(2, FRIDGE, { powerSave: { powerSaveEnabled: true } })];
    renderApp();
    await waitFor(() => assert.equal(eventItems().length, 2));
    assert.match(eventItems()[0].textContent!, /Command.*Kitchen Fridge.*Power save: On/);
    assert.match(eventItems()[1].textContent!, /State.*Dishwasher.*A › B: 1 → 2/);
  });

  it("filters by device and type", async () => {
    backend.events = [stateEvent(1, DW, "a.b", 1, 2), controlEvent(2, DW, { x: { y: 1 } }), stateEvent(3, FRIDGE, "c.d", 1, 2)];
    renderApp();
    await waitFor(() => assert.equal(eventItems().length, 3));

    await userEvent.selectOptions(screen.getByLabelText("Device"), "Dishwasher");
    await waitFor(() => assert.equal(eventItems().length, 2));
    assert.equal(backend.requests.at(-1)!.query.get("deviceId"), DW);

    await userEvent.selectOptions(screen.getByLabelText("Type"), "Commands");
    await waitFor(() => assert.equal(eventItems().length, 1));
    assert.equal(backend.requests.at(-1)!.query.get("kind"), "control");

    await userEvent.selectOptions(screen.getByLabelText("Device"), "All devices");
    await userEvent.selectOptions(screen.getByLabelText("Type"), "State changes");
    await waitFor(() => assert.deepEqual(eventItems().map((li) => li.textContent!.match(/Dishwasher|Kitchen Fridge/)![0]), ["Kitchen Fridge", "Dishwasher"]));
  });

  it("adds live events that match the filters", async () => {
    backend.events = [stateEvent(1, DW, "a.b", 1, 2)];
    renderApp();
    await waitFor(() => assert.equal(eventItems().length, 1));
    await userEvent.selectOptions(screen.getByLabelText("Device"), "Dishwasher");
    await waitFor(() => assert.equal(backend.requests.at(-1)!.query.get("deviceId"), DW));

    FakeEventSource.latest.open();
    FakeEventSource.latest.send(stateEvent(2, FRIDGE, "c.d", 1, 2));
    FakeEventSource.latest.send(stateEvent(3, DW, "a.b", 2, 3));
    await waitFor(() => assert.equal(eventItems().length, 2));
    assert.match(eventItems()[0].textContent!, /A › B: 2 → 3/);
    assert.equal(screen.queryByText(/C › D/), null, "the other device's event is filtered out");
  });

  it("shows the connection state", async () => {
    renderApp();
    const indicator = () => screen.getByText(/^(Connecting…|Live|Reconnecting…|Disconnected)$/).closest(".stream-status")!;
    await waitFor(() => assert.equal(indicator().textContent, "Connecting…"));
    FakeEventSource.latest.open();
    assert.equal(indicator().textContent, "Live");
    assert.ok(indicator().classList.contains("stream-open"));
    FakeEventSource.latest.drop();
    assert.equal(indicator().textContent, "Reconnecting…");
    FakeEventSource.latest.fail();
    assert.equal(indicator().textContent, "Disconnected");
    assert.ok(indicator().classList.contains("stream-closed"));
  });

  it("says which devices are watched and which fail", async () => {
    backend.subscribe(DW);
    backend.subscribe(FRIDGE, { lastError: "ThinQ API error 400 (code 1222)" });
    renderApp();
    await screen.findByText("Watching Dishwasher, Kitchen Fridge.");
    assert.ok(screen.getByText("Kitchen Fridge: last check failed: ThinQ API error 400 (code 1222)"));
  });

  it("explains how to start when nothing is watched", async () => {
    renderApp();
    await screen.findByText(/No devices are watched/);
    await screen.findByText("No events match.");
  });

  it("shows a paused poller and history errors", async () => {
    backend.poller = { ...backend.poller, state: "paused", resumesAt: iso(5), lastError: "ThinQ API error 401 (code 1103)" };
    backend.fail("GET /api/events", 500, "Database is locked");
    renderApp();
    await screen.findByText("Database is locked");
    assert.match((await screen.findByText(/paused until/)).textContent!, /code 1103/);
  });
});

describe("events tab pagination", () => {
  beforeEach(() => window.history.replaceState(null, "", "/#events"));

  /** `n` dishwasher events with ids 1..n (newest = n). */
  const seed = (n: number) => {
    backend.events = Array.from({ length: n }, (_, i) => stateEvent(i + 1, DW, "timer.remainMinute", i + 1, i));
  };
  const summary = () => screen.getByText(/^Showing /).textContent;
  const shownIds = () => eventItems().map((li) => Number(li.textContent!.match(/Time left \(min\): (\d+)/)![1]));
  const pageButton = (n: number) => screen.getByRole("button", { name: `Page ${n}` });
  const pageButtons = () =>
    within(screen.getByRole("navigation", { name: "Event pages" }))
      .getAllByRole("button")
      .map((b) => b.textContent);

  it("shows 25 events a page with a summary and page buttons", async () => {
    seed(60);
    renderApp();
    await waitFor(() => assert.equal(eventItems().length, 25));
    assert.equal(summary(), "Showing 1–25 of 60 events · page 1 of 3");
    assert.deepEqual(shownIds(), Array.from({ length: 25 }, (_, i) => 60 - i), "newest first");
    assert.deepEqual(pageButtons(), ["‹ Newer", "1", "2", "3", "Older ›"]);
    assert.equal(pageButton(1).getAttribute("aria-current"), "page");
    assert.ok(pageButton(1).classList.contains("active"));
    assert.equal(screen.getByRole("button", { name: "‹ Newer" }).hasAttribute("disabled"), true);
    assert.equal(screen.getByRole("button", { name: "Older ›" }).hasAttribute("disabled"), false);
  });

  it("leaves out the page buttons when everything fits on one page", async () => {
    seed(3);
    renderApp();
    await waitFor(() => assert.equal(eventItems().length, 3));
    assert.equal(summary(), "Showing 1–3 of 3 events");
    assert.equal(screen.queryByRole("navigation", { name: "Event pages" }), null);
  });

  it("moves between pages, pinned below the newest event", async () => {
    seed(60);
    renderApp();
    await waitFor(() => assert.equal(eventItems().length, 25));

    await userEvent.click(screen.getByRole("button", { name: "Older ›" }));
    await waitFor(() => assert.equal(summary(), "Showing 26–50 of 60 events · page 2 of 3"));
    assert.deepEqual(shownIds(), Array.from({ length: 25 }, (_, i) => 35 - i));
    const list = backend.last("/api/events").query;
    assert.deepEqual([list.get("offset"), list.get("limit"), list.get("before")], ["25", "25", "61"]);
    const counts = backend.requests.filter((r) => r.path === "/api/events/count").map((r) => r.query.get("before"));
    assert.ok(counts.includes("61"), "the pinned total");
    assert.ok(counts.includes(null), "and the live total, for the newer-events notice");

    await userEvent.click(pageButton(3));
    await waitFor(() => assert.equal(summary(), "Showing 51–60 of 60 events · page 3 of 3"));
    assert.deepEqual(shownIds(), Array.from({ length: 10 }, (_, i) => 10 - i));
    assert.equal(screen.getByRole("button", { name: "Older ›" }).hasAttribute("disabled"), true);

    await userEvent.click(screen.getByRole("button", { name: "‹ Newer" }));
    await waitFor(() => assert.equal(summary(), "Showing 26–50 of 60 events · page 2 of 3"));
    await userEvent.click(pageButton(1));
    await waitFor(() => assert.equal(summary(), "Showing 1–25 of 60 events · page 1 of 3"));
    assert.equal(backend.last("/api/events").query.get("before"), null, "the first page is live again");
  });

  it("shows gaps in a long list of pages", async () => {
    seed(300);
    renderApp();
    await userEvent.selectOptions(await screen.findByLabelText("Per page"), "10");
    await waitFor(() => assert.deepEqual(pageButtons(), ["‹ Newer", "1", "2", "30", "Older ›"]));
    await userEvent.click(pageButton(30));
    await waitFor(() => assert.equal(summary(), "Showing 291–300 of 300 events · page 30 of 30"));
    await userEvent.click(screen.getByRole("button", { name: "‹ Newer" }));
    await waitFor(() => assert.match(summary()!, /page 29 of 30/));
    assert.deepEqual(pageButtons(), ["‹ Newer", "1", "28", "29", "30", "Older ›"]);
    assert.equal(document.querySelectorAll(".pagination [aria-hidden=true]").length, 1, "one gap");
  });

  it("changes the page size, starting again at the first page", async () => {
    seed(60);
    renderApp();
    await waitFor(() => assert.equal(eventItems().length, 25));
    await userEvent.click(pageButton(2));
    await waitFor(() => assert.match(summary()!, /page 2/));

    await userEvent.selectOptions(screen.getByLabelText("Per page"), "50");
    await waitFor(() => assert.equal(summary(), "Showing 1–50 of 60 events · page 1 of 2"));
    assert.equal(backend.last("/api/events").query.get("limit"), "50");
    assert.equal(backend.last("/api/events").query.get("before"), null);
  });

  it("starts again at the first page when the filters change", async () => {
    seed(60);
    backend.events.push(stateEvent(61, FRIDGE, "c.d", 1, 2));
    renderApp();
    await waitFor(() => assert.equal(eventItems().length, 25));
    await userEvent.click(pageButton(2));
    await waitFor(() => assert.match(summary()!, /page 2 of 3/));

    await userEvent.selectOptions(screen.getByLabelText("Device"), "Kitchen Fridge");
    await waitFor(() => assert.equal(summary(), "Showing 1–1 of 1 event"));
    const list = backend.last("/api/events").query;
    assert.deepEqual([list.get("deviceId"), list.get("offset"), list.get("before")], [FRIDGE, null, null]);
  });

  it("keeps the first page live: new events on top, the page stays the same size", async () => {
    seed(30);
    renderApp();
    await waitFor(() => assert.equal(eventItems().length, 25));
    FakeEventSource.latest.open();
    const e = stateEvent(31, DW, "timer.remainMinute", 31, 30);
    backend.events.push(e);
    FakeEventSource.latest.send(e);
    await waitFor(() => assert.equal(shownIds()[0], 31));
    assert.equal(eventItems().length, 25);
    assert.equal(summary(), "Showing 1–25 of 31 events · page 1 of 2");
  });

  it("keeps an older page still while new events arrive, and offers the newest", async () => {
    seed(60);
    renderApp();
    await waitFor(() => assert.equal(eventItems().length, 25));
    await userEvent.click(pageButton(2));
    await waitFor(() => assert.match(summary()!, /page 2/));
    const before = shownIds();
    assert.equal(screen.queryByText(/newer event/), null);

    FakeEventSource.latest.open();
    for (const id of [61, 62]) {
      const e = stateEvent(id, DW, "timer.remainMinute", id, id - 1);
      backend.events.push(e);
      FakeEventSource.latest.send(e);
    }
    await screen.findByText("2 newer events since you left the first page.");
    assert.deepEqual(shownIds(), before, "the page did not shift");
    assert.equal(summary(), "Showing 26–50 of 60 events · page 2 of 3");

    await userEvent.click(screen.getByRole("button", { name: "Show newest" }));
    await waitFor(() => assert.equal(summary(), "Showing 1–25 of 62 events · page 1 of 3"));
    assert.equal(shownIds()[0], 62);
    assert.equal(screen.queryByText(/newer event/), null);
  });

  it("only counts newer events that match the filters", async () => {
    seed(60);
    renderApp();
    await waitFor(() => assert.equal(eventItems().length, 25));
    await userEvent.selectOptions(screen.getByLabelText("Device"), "Dishwasher");
    await waitFor(() => assert.equal(backend.last("/api/events").query.get("deviceId"), DW));
    await userEvent.click(pageButton(2));
    await waitFor(() => assert.match(summary()!, /page 2/));

    FakeEventSource.latest.open();
    const other = stateEvent(61, FRIDGE, "c.d", 1, 2);
    const mine = stateEvent(62, DW, "timer.remainMinute", 62, 61);
    backend.events.push(other, mine);
    FakeEventSource.latest.send(other);
    FakeEventSource.latest.send(mine);
    await screen.findByText("1 newer event since you left the first page.");
  });

  it("moves to the last page that still exists when the history shrinks", async () => {
    seed(60);
    renderApp();
    await waitFor(() => assert.equal(eventItems().length, 25));
    await userEvent.click(pageButton(3));
    await waitFor(() => assert.match(summary()!, /page 3 of 3/));

    backend.events = backend.events.slice(30); // the oldest 30 were pruned
    FakeEventSource.latest.sendNamed("reset", {}); // reload everything
    await waitFor(() => assert.equal(summary(), "Showing 26–30 of 30 events · page 2 of 2"));
  });

  it("can be used with the keyboard", async () => {
    seed(60);
    renderApp();
    await waitFor(() => assert.equal(eventItems().length, 25));
    pageButton(2).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => assert.match(summary()!, /page 2 of 3/));
  });
});
