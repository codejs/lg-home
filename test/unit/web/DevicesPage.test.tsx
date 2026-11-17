import { assertAbsent } from "../../helpers/dom.js";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { DevicesPage } from "../../../src/web/DevicesPage.js";
import type { Device } from "../../../src/web/api.js";
import { NO_SUBSCRIPTIONS, newQueryClient } from "../../helpers/fake-backend.js";
import { deferred, installFetch, json, type FetchHandler } from "../../helpers/fetch.js";

const device = (id: string, alias: string, type: string): Device => ({
  id,
  type,
  alias,
  modelName: null,
  reportable: true,
  raw: null,
  updatedAt: "2026-01-01T00:00:00Z",
});
const FRIDGE = device("f1", "Kitchen Fridge", "DEVICE_REFRIGERATOR");
const DISHWASHER = device("dw1", "Dishwasher", "DEVICE_DISH_WASHER");
const FRIDGE_STATE = { temperature: [{ locationName: "FRIDGE", targetTemperature: 3, unit: "C" }] };
const DISHWASHER_STATE = { runState: { currentState: "INITIAL" } };

let restore: (() => void) | undefined;

function renderPage(routes: Record<string, FetchHandler>) {
  const fetchStub = installFetch({
    "GET /api/devices/f1/status": () => json(200, FRIDGE_STATE),
    "GET /api/devices/dw1/status": () => json(200, DISHWASHER_STATE),
    "GET /api/subscriptions": () => json(200, NO_SUBSCRIPTIONS),
    ...routes,
  });
  restore = fetchStub.restore;
  const queryClient = newQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <DevicesPage user={{ id: 1, username: "alice" }} />
    </QueryClientProvider>,
  );
  return { fetchStub, queryClient, user: userEvent.setup() };
}

/** The headline figures shown on a card, once loaded. */
async function highlightsOf(name: string): Promise<string[]> {
  const card = await screen.findByRole("article", { name });
  return waitFor(() => {
    const values = [...card.querySelectorAll(".device-highlights dd, .status-pill")].map((el) => el.textContent ?? "");
    if (values.length === 0) throw new Error(`${name} has not loaded yet`);
    return values;
  });
}

/** Card names in display order. */
const cardNames = () =>
  within(screen.getByRole("list", { name: "Devices" }))
    .queryAllByRole("article")
    .map((a) => a.querySelector("h2")?.textContent);

describe("DevicesPage", () => {
  afterEach(() => {
    cleanup();
    restore?.();
  });

  it("shows the signed-in user and a sign-out button", () => {
    renderPage({ "GET /api/devices": () => json(200, []) });
    assert.ok(screen.getByText("alice"));
    assert.ok(screen.getByRole("button", { name: "Sign out" }));
  });

  it("renders one card per device, in the server's order", async () => {
    renderPage({ "GET /api/devices": () => json(200, [DISHWASHER, FRIDGE]) });
    await waitFor(() => assert.deepEqual(cardNames(), ["Dishwasher", "Kitchen Fridge"]));
  });

  it("every card loads its own status, once", async () => {
    const { fetchStub } = renderPage({ "GET /api/devices": () => json(200, [DISHWASHER, FRIDGE]) });
    assert.deepEqual(await highlightsOf("Kitchen Fridge"), ["3 °C"]);
    assert.deepEqual(await highlightsOf("Dishwasher"), ["Ready"]);
    const statusCalls = fetchStub.calls.map((c) => c.url).filter((u) => u.endsWith("/status"));
    assert.deepEqual(statusCalls.sort(), ["/api/devices/dw1/status", "/api/devices/f1/status"]);
  });

  it("one failing device doesn't affect the others", async () => {
    renderPage({
      "GET /api/devices": () => json(200, [DISHWASHER, FRIDGE]),
      "GET /api/devices/dw1/status": () => json(502, { error: "ThinQ API error 500", thinqCode: "0000" }),
    });
    const dishwasher = await screen.findByRole("article", { name: "Dishwasher" });
    await within(dishwasher).findByText("ThinQ API error 500");
    assert.deepEqual(await highlightsOf("Kitchen Fridge"), ["3 °C"]);
  });

  it("shows an empty state before the first sync", async () => {
    renderPage({ "GET /api/devices": () => json(200, []) });
    assert.ok(await screen.findByText(/No devices yet/));
    assert.deepEqual(cardNames(), []);
  });

  it("shows an error when the list can't be loaded", async () => {
    renderPage({ "GET /api/devices": () => json(500, { error: "Internal Server Error" }) });
    assert.ok(await screen.findByText("Internal Server Error"));
  });

  it("syncs from ThinQ and shows the new cards", async () => {
    const pending = deferred<Response>();
    const { user } = renderPage({
      "GET /api/devices": () => json(200, []),
      "POST /api/devices/sync": () => pending.promise,
    });
    await screen.findByText(/No devices yet/);
    const button = screen.getByRole("button", { name: "Sync from ThinQ" }) as HTMLButtonElement;
    await user.click(button);
    await waitFor(() => assert.equal(button.textContent, "Syncing…"));
    assert.equal(button.disabled, true, "no double sync");
    pending.resolve(json(200, [FRIDGE, DISHWASHER]));
    await waitFor(() => assert.deepEqual(cardNames(), ["Kitchen Fridge", "Dishwasher"]));
    assert.equal(button.textContent, "Sync from ThinQ");
    assertAbsent(screen.queryByText(/No devices yet/), "empty-state text");
  });

  it("shows sync errors and keeps the existing cards", async () => {
    const { user } = renderPage({
      "GET /api/devices": () => json(200, [FRIDGE]),
      "POST /api/devices/sync": () => json(502, { error: "ThinQ API error 401 (code 1103): Invalid token" }),
    });
    await screen.findByRole("article", { name: "Kitchen Fridge" });
    await user.click(screen.getByRole("button", { name: "Sync from ThinQ" }));
    assert.ok(await screen.findByText(/Invalid token/));
    assert.deepEqual(cardNames(), ["Kitchen Fridge"]);
  });

  it("renders hostile device names as text (XSS)", async () => {
    const alias = `<img src=x onerror="window.__xss=1">`;
    renderPage({
      "GET /api/devices": () => json(200, [device("evil", alias, "DEVICE_<b>X</b>")]),
      "GET /api/devices/evil/status": () => json(200, { note: "<script>window.__xss=2</script>" }),
    });
    const card = await screen.findByRole("article", { name: alias });
    await waitFor(() => assert.match(card.textContent ?? "", /Updated/), { timeout: 2000 }); // status loaded
    assertAbsent(document.querySelector("main img, main script, main b"), "injected HTML element");
    assert.equal((window as { __xss?: number }).__xss, undefined);
  });
});
