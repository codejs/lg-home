import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeState,
  deviceTypeLabel,
  formatDuration,
  formatNumber,
  formatValue,
  formatWithUnit,
  humanizeEnum,
  humanizeKey,
  locationLabel,
  summarize,
  type Json,
} from "../../../src/web/deviceFormat.js";
import { FakeDishWasher, FakeRefrigerator } from "../../fake-thinq/devices.js";

const MIN = 60_000;
const NOW = new Date(2026, 0, 1, 10, 0, 0); // local 10:00

/** Real state from the fake appliances, so UI and fake stay in step. */
function fridgeState(patch: Json = {}): Json {
  const fridge = new FakeRefrigerator();
  fridge.patchState(patch);
  return fridge.snapshot(0);
}

function dishwasherState(options: { startedMinutesAgo?: number; patch?: Json } = {}): Json {
  const dw = new FakeDishWasher();
  dw.patchState({ remoteControlEnable: { remoteControlEnabled: true }, ...options.patch });
  if (options.startedMinutesAgo !== undefined) {
    dw.control({ operation: { dishWasherOperationMode: "START" } }, 0);
    return dw.snapshot(options.startedMinutesAgo * MIN);
  }
  return dw.snapshot(0);
}

describe("labels", () => {
  it("humanizeKey turns camelCase into a sentence-case label", () => {
    assert.equal(humanizeKey("windStrength"), "Wind strength");
    assert.equal(humanizeKey("brightnessLevel"), "Brightness level");
    assert.equal(humanizeKey("x"), "X");
  });

  it("humanizeKey prefers curated labels", () => {
    assert.equal(humanizeKey("expressMode"), "Express freeze");
    assert.equal(humanizeKey("expressFridge"), "Express cool");
    assert.equal(humanizeKey("remoteControlEnabled"), "Remote start");
    assert.equal(humanizeKey("currentState"), "Status");
  });

  it("humanizeKey maps per-appliance key families to one name", () => {
    assert.equal(humanizeKey("airConOperationMode"), "Power");
    assert.equal(humanizeKey("airPurifierOperationMode"), "Power");
    assert.equal(humanizeKey("currentJobMode"), "Mode");
    assert.equal(humanizeKey("washerJobMode"), "Mode");
    assert.equal(humanizeKey("currentDishWashingCourse"), "Programme");
    assert.equal(humanizeKey("dryerCourse"), "Programme");
  });

  it("humanizeKey keeps acronyms", () => {
    assert.equal(humanizeKey("uvLampHours"), "UV lamp hours");
    assert.equal(humanizeKey("pm10Level"), "PM10 level");
    assert.equal(humanizeKey("wifiSignal"), "Wi-Fi signal");
    assert.equal(humanizeKey("LEDBrightness"), "LED brightness");
    assert.equal(humanizeKey("co2Level"), "CO2 level");
  });

  it("humanizeKey handles snake_case, kebab-case and odd input", () => {
    assert.equal(humanizeKey("filter_life"), "Filter life");
    assert.equal(humanizeKey("filter-life"), "Filter life");
    assert.equal(humanizeKey(""), "");
    assert.equal(humanizeKey("___"), "___");
    assert.equal(humanizeKey("level2Setting"), "Level2 setting");
  });

  it("humanizeEnum reads like prose", () => {
    assert.equal(humanizeEnum("POWER_OFF"), "Off");
    assert.equal(humanizeEnum("INITIAL"), "Ready");
    assert.equal(humanizeEnum("END"), "Finished");
    assert.equal(humanizeEnum("CLOSE"), "Closed");
    assert.equal(humanizeEnum("LEVEL_2"), "Level 2");
    assert.equal(humanizeEnum("ON_THE_LENS"), "On the lens");
    assert.equal(humanizeEnum("AUTO"), "Auto");
    assert.equal(humanizeEnum("A__B"), "A b");
  });

  it("locationLabel names compartments", () => {
    assert.equal(locationLabel("FRIDGE"), "Fridge");
    assert.equal(locationLabel("FREEZER"), "Freezer");
    assert.equal(locationLabel("UPPER_DRAWER"), "Upper drawer");
  });

  it("deviceTypeLabel knows common ThinQ types and humanises the rest", () => {
    assert.equal(deviceTypeLabel("DEVICE_DISH_WASHER"), "Dishwasher");
    assert.equal(deviceTypeLabel("DEVICE_REFRIGERATOR"), "Refrigerator");
    assert.equal(deviceTypeLabel("DEVICE_AIR_CONDITIONER"), "Air conditioner");
    assert.equal(deviceTypeLabel("DEVICE_ROBOT_CLEANER"), "Robot vacuum");
    assert.equal(deviceTypeLabel("DEVICE_HOLO_PROJECTOR"), "Holo projector");
    assert.equal(deviceTypeLabel("TOASTER"), "Toaster");
  });
});

describe("values", () => {
  it("formatNumber uses a real minus sign and at most one decimal", () => {
    assert.equal(formatNumber(-18), "\u221218");
    assert.equal(formatNumber(3), "3");
    assert.equal(formatNumber(26.55), "26.6");
    assert.equal(formatNumber(1234), "1,234");
    assert.equal(formatNumber(0), "0");
  });

  it("formatWithUnit renders temperatures and counted units", () => {
    assert.equal(formatWithUnit(3, "C"), "3 °C");
    assert.equal(formatWithUnit(-4, "F"), "\u22124 °F");
    assert.equal(formatWithUnit(1, "MONTH"), "1 month");
    assert.equal(formatWithUnit(4, "MONTH"), "4 months");
    assert.equal(formatWithUnit(0, "MONTH"), "0 months");
    assert.equal(formatWithUnit(40, "PERCENT"), "40%");
    assert.equal(formatWithUnit(7, "kWh"), "7 kWh");
    assert.equal(formatWithUnit(7, undefined), "7");
    assert.equal(formatWithUnit(22, undefined, "targetTemperature"), "22°", "temperature without a unit");
    assert.equal(formatWithUnit(5, ""), "5");
  });

  it("formatDuration", () => {
    assert.equal(formatDuration(0), "0 min");
    assert.equal(formatDuration(45), "45 min");
    assert.equal(formatDuration(60), "1 h");
    assert.equal(formatDuration(75), "1 h 15 min");
    assert.equal(formatDuration(135), "2 h 15 min");
    assert.equal(formatDuration(59.6), "1 h", "rounds to whole minutes");
    for (const bad of [-1, NaN, Infinity]) assert.equal(formatDuration(bad), "—");
  });

  it("formatValue covers every JSON type", () => {
    assert.equal(formatValue("x", null), "—");
    assert.equal(formatValue("x", undefined), "—");
    assert.equal(formatValue("x", ""), "—");
    assert.equal(formatValue("powerSaveEnabled", true), "On");
    assert.equal(formatValue("powerSaveEnabled", false), "Off");
    assert.equal(formatValue("rinseRefill", true), "Refill needed");
    assert.equal(formatValue("rinseRefill", false), "OK");
    assert.equal(formatValue("targetTemperature", 3, "C"), "3 °C");
    assert.equal(formatValue("x", NaN), "—");
    assert.equal(formatValue("x", Infinity), "—");
    assert.equal(formatValue("doorState", "OPEN"), "Open");
    assert.equal(formatValue("firmware", "1.2.3"), "1.2.3", "free text is kept");
    assert.equal(formatValue("name", "Kitchen"), "Kitchen");
    assert.equal(formatValue("codes", ["E1", "E7"]), "E1, E7");
    assert.equal(formatValue("modes", ["AUTO", "TURBO"]), "Auto, Turbo");
    assert.equal(formatValue("codes", []), "—");
    assert.equal(formatValue("x", { a: 1 }), '{"a":1}');
  });

  it("formatValue passes hostile strings through untouched (React escapes them)", () => {
    const evil = "<img src=x onerror=alert(1)>";
    assert.equal(formatValue("note", evil), evil);
  });
});

describe("describeState", () => {
  it("describes the fridge: overview, per-compartment temperatures, grouped settings", () => {
    assert.deepEqual(describeState(fridgeState()), [
      {
        title: "",
        rows: [
          { label: "Door", value: "Closed" },
          { label: "Power save", value: "Off" },
          { label: "Eco mode", value: "Off" },
          { label: "Sabbath mode", value: "Off" },
        ],
      },
      {
        title: "Temperature",
        rows: [
          { label: "Fridge · Target temperature", value: "3 °C" },
          { label: "Freezer · Target temperature", value: "\u221218 °C" },
        ],
      },
      {
        title: "Cooling",
        rows: [
          { label: "Express freeze", value: "Off" },
          { label: "Express cool", value: "Off" },
          { label: "Fresh air filter", value: "Auto" },
        ],
      },
      { title: "Water filter", rows: [{ label: "In use for", value: "4 months" }] },
    ]);
  });

  it("describes a running dishwasher, combining hour/minute timers", () => {
    const groups = describeState(dishwasherState({ startedMinutesAgo: 60 }));
    const timer = groups.find((g) => g.title === "Timer");
    assert.deepEqual(timer?.rows, [
      { label: "Time left", value: "1 h 15 min" },
      { label: "Programme length", value: "2 h 15 min" },
    ]);
    assert.deepEqual(groups[0].rows.slice(0, 2), [
      { label: "Status", value: "Running" },
      { label: "Door", value: "Closed" },
    ]);
    assert.deepEqual(groups.find((g) => g.title === "Preferences")?.rows, [
      { label: "Rinse aid level", value: "Level 2" },
      { label: "Water softening", value: "Level 3" },
    ]);
  });

  it("names locations only when there are several", () => {
    const one = describeState({ doorStatus: [{ locationName: "MAIN", doorState: "OPEN" }] });
    assert.deepEqual(one, [{ title: "", rows: [{ label: "Door", value: "Open" }] }]);
    const two = describeState({
      doorStatus: [
        { locationName: "FRIDGE", doorState: "OPEN" },
        { locationName: "FREEZER", doorState: "CLOSE" },
      ],
    });
    assert.deepEqual(two[0].rows.map((r) => r.label), ["Fridge · Door", "Freezer · Door"]);
  });

  it("folds a unit into its number but shows a lone unit as a row", () => {
    assert.deepEqual(describeState({ filter: { usedTime: 1, unit: "MONTH" } })[0].rows, [
      { label: "In use for", value: "1 month" },
    ]);
    assert.deepEqual(describeState({ display: { unit: "C", theme: "DARK" } })[0].rows, [
      { label: "Unit", value: "C" },
      { label: "Theme", value: "Dark" },
    ]);
  });

  it("pairs any XHour/XMinute and XHourY/XMinuteY timers, leaving unpaired ones alone", () => {
    const rows = describeState({
      timer: { relativeHourToStop: 1, relativeMinuteToStop: 30, sleepHour: 2, absoluteHourToStart: 7, absoluteMinuteToStart: 5 },
    })[0].rows;
    assert.deepEqual(rows, [
      { label: "Stops in", value: "1 h 30 min" },
      { label: "Sleep hour", value: "2" },
      { label: "Absolute to start", value: "7 h 5 min" },
    ]);
  });

  it("flattens nested objects with a breadcrumb", () => {
    const rows = describeState({ filter: { main: { remaining: 80 }, pre: { state: "CLEAN" } } })[0].rows;
    assert.deepEqual(rows, [
      { label: "Main › Remaining", value: "80" },
      { label: "Pre › State", value: "Clean" },
    ]);
  });

  it("puts top-level scalars and lists into the overview", () => {
    assert.deepEqual(describeState({ firmware: "1.2.3", online: true, errors: ["E1"] }), [
      {
        title: "",
        rows: [
          { label: "Firmware", value: "1.2.3" },
          { label: "Online", value: "On" },
          { label: "Errors", value: "E1" },
        ],
      },
    ]);
  });

  it("skips empty resources and handles an empty state", () => {
    assert.deepEqual(describeState({}), []);
    assert.deepEqual(describeState({ timer: {}, doorStatus: [], firmware: "1.0" }), [
      { title: "", rows: [{ label: "Firmware", value: "1.0" }] },
    ]);
  });

  it("keeps multi-row groups with their heading, even if one row repeats it", () => {
    const groups = describeState({ powerSave: { powerSaveEnabled: true, level: 2 } });
    assert.equal(groups[0].title, "Power save");
    assert.equal(groups[0].rows.length, 2);
  });
});

describe("summarize", () => {
  it("fridge: compartment temperatures, no status, nothing to flag", () => {
    assert.deepEqual(summarize(fridgeState(), NOW), {
      highlights: [
        { label: "Fridge", value: "3 °C" },
        { label: "Freezer", value: "\u221218 °C" },
      ],
      alerts: [],
      features: [],
    });
  });

  it("fridge: open door, filter to replace and active modes", () => {
    const s = summarize(
      fridgeState({
        doorStatus: [{ locationName: "MAIN", doorState: "OPEN" }],
        refrigeration: { expressMode: true, freshAirFilter: "REPLACE" },
        ecoFriendly: { ecoFriendlyMode: true },
      }),
      NOW,
    );
    assert.deepEqual(s.alerts, ["Door open", "Replace the fresh air filter"]);
    assert.deepEqual(s.features, ["Eco mode", "Express freeze"]);
  });

  it("names the compartment whose door is open", () => {
    const s = summarize({ doorStatus: [{ locationName: "FREEZER", doorState: "OPEN" }] }, NOW);
    assert.deepEqual(s.alerts, ["Door open (Freezer)"]);
  });

  it("dishwasher ready: idle status, programme, remote start on", () => {
    const s = summarize(dishwasherState(), NOW);
    assert.deepEqual(s.status, { label: "Ready", tone: "idle" });
    assert.deepEqual(s.highlights, [{ label: "Programme", value: "Auto" }]);
    assert.equal(s.progress, undefined);
    assert.deepEqual(s.features, ["Remote start"]);
  });

  it("dishwasher running: time left with end time, progress", () => {
    const s = summarize(dishwasherState({ startedMinutesAgo: 60 }), NOW);
    assert.deepEqual(s.status, { label: "Running", tone: "active" });
    assert.deepEqual(s.highlights, [
      { label: "Time left", value: "1 h 15 min", hint: "ends ~11:15" },
      { label: "Programme", value: "Auto" },
    ]);
    assert.deepEqual(s.progress, { remaining: 75, total: 135 });
  });

  it("dishwasher finished: done tone, no timer", () => {
    const s = summarize(dishwasherState({ startedMinutesAgo: 500 }), NOW);
    assert.deepEqual(s.status, { label: "Finished", tone: "done" });
    assert.equal(s.progress, undefined);
    assert.ok(!s.highlights.some((h) => h.label === "Time left"));
  });

  it("paused: shows time left and progress but no end time", () => {
    const s = summarize({ runState: { currentState: "PAUSE" }, timer: { remainHour: 0, remainMinute: 20, totalHour: 1, totalMinute: 0 } }, NOW);
    assert.equal(s.status?.tone, "paused");
    assert.deepEqual(s.highlights, [{ label: "Time left", value: "20 min" }]);
    assert.deepEqual(s.progress, { remaining: 20, total: 60 });
  });

  it("maps run states to tones", () => {
    const tone = (state: string) => summarize({ runState: { currentState: state } }, NOW).status?.tone;
    assert.equal(tone("POWER_OFF"), "off");
    assert.equal(tone("SLEEP"), "off");
    assert.equal(tone("INITIAL"), "idle");
    assert.equal(tone("STANDBY"), "idle");
    assert.equal(tone("RESERVED"), "idle");
    assert.equal(tone("RUNNING"), "active");
    assert.equal(tone("RINSING"), "active");
    assert.equal(tone("SPINNING"), "active");
    assert.equal(tone("DRYING"), "active");
    assert.equal(tone("PAUSE"), "paused");
    assert.equal(tone("END"), "done");
    assert.equal(tone("ERROR"), "error");
    assert.equal(tone("SOMETHING_NEW"), "idle", "unknown states are neutral");
  });

  it("an error state raises an alert", () => {
    assert.deepEqual(summarize({ runState: { currentState: "ERROR" } }, NOW).alerts, ["The appliance reports an error"]);
  });

  it("rinse aid refill raises an alert", () => {
    const s = summarize(dishwasherState({ patch: { dishWashingStatus: { rinseRefill: true } } }), NOW);
    assert.deepEqual(s.alerts, ["Rinse aid needs a refill"]);
  });

  it("air conditioner: power from the operation mode, room and target temperature, mode", () => {
    const ac = {
      operation: { airConOperationMode: "POWER_ON" },
      airConJobMode: { currentJobMode: "COOL" },
      temperature: { currentTemperature: 26.5, targetTemperature: 22, unit: "C" },
    };
    assert.deepEqual(summarize(ac, NOW), {
      status: { label: "On", tone: "active" },
      highlights: [
        { label: "Now", value: "26.5 °C" },
        { label: "Target", value: "22 °C" },
        { label: "Mode", value: "Cool" },
      ],
      alerts: [],
      features: [],
    });
    const off = summarize({ ...ac, operation: { airConOperationMode: "POWER_OFF" } }, NOW);
    assert.deepEqual(off.status, { label: "Off", tone: "off" });
  });

  it("compartments with current and target temperatures label the target", () => {
    const s = summarize({ temperature: [{ locationName: "FRIDGE", currentTemperature: 4, targetTemperature: 3, unit: "C" }] }, NOW);
    assert.deepEqual(s.highlights, [
      { label: "Fridge", value: "4 °C" },
      { label: "Fridge", value: "3 °C", hint: "target" },
    ]);
  });

  it("reads runState when ThinQ sends it as a location array", () => {
    const s = summarize({ runState: [{ locationName: "UPPER", currentState: "RUNNING" }] }, NOW);
    assert.equal(s.status?.label, "Running");
  });

  it("does not invent progress from a zero or missing total", () => {
    const base = { runState: { currentState: "RUNNING" } };
    assert.equal(summarize({ ...base, timer: { remainHour: 0, remainMinute: 5, totalHour: 0, totalMinute: 0 } }, NOW).progress, undefined);
    assert.equal(summarize({ ...base, timer: { remainHour: 0, remainMinute: 5 } }, NOW).progress, undefined);
  });

  it("clamps progress when remaining exceeds total", () => {
    const s = summarize({ runState: { currentState: "RUNNING" }, timer: { remainMinute: 90, totalMinute: 60 } }, NOW);
    assert.deepEqual(s.progress, { remaining: 60, total: 60 });
  });

  it("ignores the timer when the device isn't running", () => {
    const s = summarize({ runState: { currentState: "INITIAL" }, timer: { remainHour: 1, remainMinute: 0, totalHour: 1, totalMinute: 0 } }, NOW);
    assert.deepEqual(s.highlights, []);
    assert.equal(s.progress, undefined);
  });

  it("an empty state summarises to nothing", () => {
    assert.deepEqual(summarize({}, NOW), { highlights: [], alerts: [], features: [] });
  });
});

describe("robustness against malformed state", () => {
  const weird: Json[] = [
    { runState: null },
    { runState: "RUNNING" },
    { runState: { currentState: 42 } },
    { runState: [null, 1, "x"] },
    { timer: { remainHour: "1", remainMinute: null } },
    { timer: { remainHour: NaN, totalHour: Infinity } },
    { temperature: "hot" },
    { temperature: [{ targetTemperature: "3" }, null] },
    { doorStatus: "OPEN" },
    { doorStatus: [{ doorState: 1 }] },
    { operation: { airConOperationMode: 5 } },
    { a: { b: { c: { d: { e: "deep" } } } } },
    { "": "empty key", "   ": 1 },
    JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"x": 1}}}'),
    Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`key${i}`, i])),
  ];
  for (const state of weird) {
    it(`never throws: ${JSON.stringify(state).slice(0, 60)}`, () => {
      const groups = describeState(state);
      const summary = summarize(state, NOW);
      assert.ok(Array.isArray(groups));
      for (const g of groups) for (const r of g.rows) assert.equal(typeof r.value, "string");
      assert.ok(Array.isArray(summary.highlights));
      for (const h of summary.highlights) assert.ok(!/NaN|undefined|\[object/.test(h.value), h.value);
      assert.equal(({} as Json).polluted, undefined, "no prototype pollution");
    });
  }

  it("treats a __proto__ key from the network as plain data", () => {
    const state = JSON.parse('{"__proto__": {"polluted": true}}');
    assert.deepEqual(describeState(state), [{ title: "Proto", rows: [{ label: "Polluted", value: "On" }] }]);
  });

  // Regression: label tables are object literals, so "constructor" resolved to
  // Object.prototype.constructor (a function) and crashed the whole card.
  it("treats keys and values named like Object.prototype members as plain text", () => {
    const state = { constructor: { toString: "valueOf", hasOwnProperty: 1 }, runState: { currentState: "constructor" } };
    assert.deepEqual(describeState(state), [
      { title: "", rows: [{ label: "Status", value: "constructor" }] },
      { title: "Constructor", rows: [{ label: "To string", value: "valueOf" }, { label: "Has own property", value: "1" }] },
    ]);
    assert.equal(humanizeKey("toString"), "To string");
    assert.equal(humanizeEnum("VALUE_OF"), "Value of");
    assert.equal(deviceTypeLabel("constructor"), "Constructor");
    assert.equal(locationLabel("__proto__"), "Proto");
    assert.equal(formatWithUnit(1, "constructor"), "1 constructor");
    assert.equal(formatValue("constructor", true), "On");
    assert.equal(summarize({ runState: { currentState: "toString" } }, NOW).status?.tone, "idle");
  });
});
