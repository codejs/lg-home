import { assertAbsent } from "../../helpers/dom.js";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeviceCard } from "../../../src/web/DeviceCard.js";
import { deviceFamily } from "../../../src/web/DeviceIcon.js";
import type { Device } from "../../../src/web/api.js";
import { FakeDishWasher, FakeRefrigerator } from "../../fake-thinq/devices.js";
import { deferred, installFetch, json, type FetchHandler } from "../../helpers/fetch.js";

const FRIDGE: Device = {
  id: "f1",
  type: "DEVICE_REFRIGERATOR",
  alias: "Kitchen Fridge",
  modelName: "GBB92STAXP",
  reportable: true,
  updatedAt: "",
};
const DISHWASHER: Device = { ...FRIDGE, id: "dw1", type: "DEVICE_DISH_WASHER", alias: "Dishwasher", modelName: "DFB532FP" };

function fridgeState(patch: Record<string, unknown> = {}) {
  const fridge = new FakeRefrigerator();
  fridge.patchState(patch);
  return fridge.snapshot(0);
}

function runningDishwasher(minutesIn: number) {
  const dw = new FakeDishWasher();
  dw.patchState({ remoteControlEnable: { remoteControlEnabled: true } });
  dw.control({ operation: { dishWasherOperationMode: "START" } }, 0);
  return dw.snapshot(minutesIn * 60_000);
}

let restore: (() => void) | undefined;

function renderCard(device: Device, status: FetchHandler) {
  const fetchStub = installFetch({ [`GET /api/devices/${encodeURIComponent(device.id)}/status`]: status });
  restore = fetchStub.restore;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DeviceCard device={device} />
    </QueryClientProvider>,
  );
  const card = () => screen.getByRole("article", { name: device.alias });
  return { fetchStub, queryClient, card, user: userEvent.setup() };
}

const pill = (card: HTMLElement) => card.querySelector(".status-pill");

describe("DeviceCard", () => {
  afterEach(() => {
    cleanup();
    restore?.();
  });

  describe("identity", () => {
    it("is an article named by the device alias, with type and model", async () => {
      const { card } = renderCard(FRIDGE, () => json(200, fridgeState()));
      assert.equal(within(card()).getByRole("heading", { level: 2 }).textContent, "Kitchen Fridge");
      assert.ok(within(card()).getByText("Refrigerator · GBB92STAXP"));
    });

    it("doesn't repeat the type when the alias is the type", async () => {
      const { card } = renderCard(DISHWASHER, () => json(200, {}));
      assert.ok(within(card()).getByText("DFB532FP"));
      assertAbsent(within(card()).queryByText(/Dishwasher ·/), "repeated type in subtitle");
    });

    it("copes with a missing model name", async () => {
      const { card } = renderCard({ ...FRIDGE, modelName: null }, () => json(200, {}));
      assert.ok(within(card()).getByText("Refrigerator"));
    });

    it("shows an icon for the appliance family", () => {
      const { card } = renderCard(FRIDGE, () => json(200, {}));
      const icon = card().querySelector("svg.device-icon");
      assert.equal(icon?.getAttribute("data-family"), "fridge");
      assert.equal(icon?.getAttribute("aria-hidden"), "true", "decorative");
    });
  });

  describe("states", () => {
    it("shows a loading state until status arrives", async () => {
      const pending = deferred<Response>();
      const { card } = renderCard(FRIDGE, () => pending.promise);
      assert.equal(within(card()).getByRole("status").textContent, "Loading status…");
      assert.equal(card().getAttribute("aria-busy"), "true");
      pending.resolve(json(200, fridgeState()));
      await within(card()).findByText("Fridge");
      assertAbsent(within(card()).queryByRole("status"), "loading indicator");
      await waitFor(() => assert.equal(card().getAttribute("aria-busy"), "false"));
    });

    it("fridge: compartment temperatures without a status pill", async () => {
      const { card } = renderCard(FRIDGE, () => json(200, fridgeState()));
      const highlights = await waitFor(() => {
        const dl = card().querySelector(".device-highlights");
        if (!dl) throw new Error("no highlights yet");
        return dl;
      });
      assert.deepEqual(
        [...highlights.querySelectorAll("div")].map((d) => [d.querySelector("dt")?.textContent, d.querySelector("dd")?.textContent]),
        [
          ["Fridge", "3 °C"],
          ["Freezer", "\u221218 °C"],
        ],
      );
      assertAbsent(pill(card()), "status pill");
      assertAbsent(card().querySelector(".device-alerts"), "alerts");
    });

    it("fridge: alerts and active features", async () => {
      const state = fridgeState({
        doorStatus: [{ locationName: "MAIN", doorState: "OPEN" }],
        refrigeration: { expressMode: true },
      });
      const { card } = renderCard(FRIDGE, () => json(200, state));
      const alerts = await within(card()).findByRole("list", { name: "Alerts" });
      assert.deepEqual([...alerts.querySelectorAll("li")].map((li) => li.textContent), ["Door open"]);
      const features = within(card()).getByRole("list", { name: "Active features" });
      assert.deepEqual([...features.querySelectorAll("li")].map((li) => li.textContent), ["Express freeze"]);
    });

    it("running dishwasher: status pill, time left and accessible progress", async () => {
      const { card } = renderCard(DISHWASHER, () => json(200, runningDishwasher(60)));
      const bar = await within(card()).findByRole("progressbar", { name: "Programme progress" });
      assert.equal(bar.getAttribute("aria-valuenow"), "44"); // 60 of 135 minutes
      assert.equal(bar.getAttribute("aria-valuetext"), "44% done");
      assert.equal((bar.firstElementChild as HTMLElement).style.width, "44%");
      assert.equal(pill(card())?.textContent, "Running");
      assert.equal(pill(card())?.getAttribute("data-tone"), "active");
      assert.match(card().querySelector(".device-highlights")?.textContent ?? "", /Time left1 h 15 min ends ~\d\d:\d\d/);
    });

    it("finished dishwasher: done pill and no progress bar", async () => {
      const { card } = renderCard(DISHWASHER, () => json(200, runningDishwasher(500)));
      await waitFor(() => assert.equal(pill(card())?.textContent, "Finished"));
      assert.equal(pill(card())?.getAttribute("data-tone"), "done");
      assertAbsent(within(card()).queryByRole("progressbar"), "progress bar");
    });

    it("offline device: a helpful message instead of an error", async () => {
      const { card } = renderCard(FRIDGE, () =>
        json(502, { error: "ThinQ API error 400 (code 1222): Not connected device", thinqStatus: 400, thinqCode: "1222" }),
      );
      await within(card()).findByText(/isn’t connected to ThinQ/);
      assert.equal(pill(card())?.textContent, "Offline");
      assert.equal(pill(card())?.getAttribute("data-tone"), "off");
      assertAbsent(within(card()).queryByText(/code 1222/), "raw ThinQ error");
    });

    it("other failures show the error message", async () => {
      const { card } = renderCard(FRIDGE, () => json(502, { error: "ThinQ API error 401 (code 1103): Invalid token", thinqCode: "1103" }));
      const error = await within(card()).findByText(/Invalid token/);
      assert.equal(error.className, "error");
      assertAbsent(pill(card()), "status pill");
    });

    it("an empty state still renders a tidy card", async () => {
      const { card } = renderCard(FRIDGE, () => json(200, {}));
      await waitFor(() => assert.match(card().textContent ?? "", /Updated \d\d:\d\d/));
      assertAbsent(card().querySelector(".device-details"), "details section");
    });
  });

  describe("details", () => {
    it("lists every property in collapsed details, with the raw JSON nested inside", async () => {
      const state = fridgeState();
      const { card } = renderCard(FRIDGE, () => json(200, state));
      const details = await waitFor(() => {
        const el = card().querySelector("details.device-details") as HTMLDetailsElement | null;
        if (!el) throw new Error("no details yet");
        return el;
      });
      assert.equal(details.open, false, "collapsed by default");
      assert.equal(details.querySelector("summary")?.textContent, "All details");
      const headings = [...details.querySelectorAll("h3")].map((h) => h.textContent);
      assert.deepEqual(headings, ["Temperature", "Cooling", "Water filter"]);
      const rows = [...details.querySelectorAll("section dl div")].map(
        (d) => `${d.querySelector("dt")?.textContent}=${d.querySelector("dd")?.textContent}`,
      );
      assert.ok(rows.includes("Door=Closed"));
      assert.ok(rows.includes("Freezer · Target temperature=\u221218 °C"));
      assert.ok(rows.includes("In use for=4 months"));
      const raw = details.querySelector("details.device-raw pre")?.textContent ?? "";
      assert.deepEqual(JSON.parse(raw), state);
    });
  });

  describe("refresh", () => {
    it("refetches on demand and shows when it last updated", async () => {
      let calls = 0;
      const { card, user, fetchStub } = renderCard(FRIDGE, () => json(200, fridgeState({ temperature: [{ locationName: "FRIDGE", targetTemperature: ++calls + 1 }] })));
      const fridgeHighlight = () => card().querySelector(".device-highlights dd")?.textContent;
      await waitFor(() => assert.equal(fridgeHighlight(), "2 °C"));
      assert.match(card().textContent ?? "", /Updated \d\d:\d\d/);
      const button = within(card()).getByRole("button", { name: "Refresh Kitchen Fridge" });
      await user.click(button);
      await waitFor(() => assert.equal(fridgeHighlight(), "3 °C"));
      assert.equal(fetchStub.calls.length, 2);
    });

    it("disables refresh while a request is in flight", async () => {
      const pending = deferred<Response>();
      const { card } = renderCard(FRIDGE, () => pending.promise);
      const button = within(card()).getByRole("button", { name: "Refresh Kitchen Fridge" }) as HTMLButtonElement;
      assert.equal(button.disabled, true);
      assert.equal(button.textContent, "Refreshing…");
      pending.resolve(json(200, {}));
      await waitFor(() => assert.equal(button.disabled, false));
      assert.equal(button.textContent, "Refresh");
    });
  });

  describe("security", () => {
    it("renders hostile aliases, models and state as text", async () => {
      const evil = `<img src=x onerror="window.__xss=1">`;
      const device = { ...FRIDGE, id: "x/../y?z", alias: evil, modelName: "<script>window.__xss=2</script>", type: "<b>T</b>" };
      const { card, fetchStub } = renderCard(device, () => json(200, { [evil]: { note: evil }, firmware: "</pre><script>x()</script>" }));
      await waitFor(() => assert.match(card().textContent ?? "", /Updated/));
      assert.equal(within(card()).getByRole("heading", { level: 2 }).textContent, evil);
      assertAbsent(document.querySelector("article img, article script, article b"), "injected HTML element");
      assert.equal((window as { __xss?: number }).__xss, undefined);
      assert.equal(fetchStub.calls[0].url, `/api/devices/${encodeURIComponent("x/../y?z")}/status`, "id is URL-encoded");
    });

    // Regression: the raw device id went into aria-labelledby, which is a
    // space-separated id list, so "a b" pointed at two non-existent elements.
    it("stays labelled by its alias whatever the device id looks like", () => {
      renderCard({ ...FRIDGE, id: 'a b"c' }, () => json(200, {}));
      const article = screen.getByRole("article", { name: "Kitchen Fridge" });
      assert.ok(!/\s/.test(article.getAttribute("aria-labelledby") ?? " "), "single id reference");
    });

    it("gives two cards distinct label ids", () => {
      const fetchStub = installFetch({
        "GET /api/devices/f1/status": () => json(200, {}),
        "GET /api/devices/f2/status": () => json(200, {}),
      });
      restore = fetchStub.restore;
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
      render(
        <QueryClientProvider client={queryClient}>
          <DeviceCard device={FRIDGE} />
          <DeviceCard device={{ ...FRIDGE, id: "f2", alias: "Garage Fridge" }} />
        </QueryClientProvider>,
      );
      const a = screen.getByRole("article", { name: "Kitchen Fridge" }).getAttribute("aria-labelledby");
      const b = screen.getByRole("article", { name: "Garage Fridge" }).getAttribute("aria-labelledby");
      assert.notEqual(a, b);
    });
  });
});

describe("deviceFamily", () => {
  it("groups ThinQ device types for icons", () => {
    assert.equal(deviceFamily("DEVICE_REFRIGERATOR"), "fridge");
    assert.equal(deviceFamily("DEVICE_KIMCHI_REFRIGERATOR"), "fridge");
    assert.equal(deviceFamily("DEVICE_DISH_WASHER"), "dishwasher");
    assert.equal(deviceFamily("DEVICE_WASHER"), "laundry");
    assert.equal(deviceFamily("DEVICE_WASHTOWER_DRYER"), "laundry");
    assert.equal(deviceFamily("DEVICE_STYLER"), "laundry");
    assert.equal(deviceFamily("DEVICE_AIR_CONDITIONER"), "air");
    assert.equal(deviceFamily("DEVICE_DEHUMIDIFIER"), "air");
    assert.equal(deviceFamily("DEVICE_OVEN"), "cooking");
    assert.equal(deviceFamily("DEVICE_MICROWAVE_OVEN"), "cooking");
    assert.equal(deviceFamily("DEVICE_ROBOT_CLEANER"), "robot");
    assert.equal(deviceFamily("DEVICE_HOLO_PROJECTOR"), "generic");
  });
});
