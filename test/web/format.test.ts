/** Unit tests for the browser-side event helpers (parsing, summaries, status merging). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyReport,
  changesOf,
  flattenCommand,
  formatTime,
  formatValue,
  matchesFilter,
  parseEvent,
  summarizeEvent,
} from "../../src/web/events/format";
import { DW, FRIDGE, controlEvent, stateEvent } from "./helpers";

describe("parseEvent", () => {
  const valid = { id: 7, deviceId: DW, kind: "event", payload: { changes: [] }, createdAt: "2026-01-01T09:00:00.000Z" };

  it("accepts a stored event", () => {
    assert.deepEqual(parseEvent(JSON.stringify(valid)), valid);
    assert.deepEqual(parseEvent(JSON.stringify({ ...valid, deviceId: null })), { ...valid, deviceId: null });
  });

  it("drops extra fields", () => {
    assert.deepEqual(parseEvent(JSON.stringify({ ...valid, extra: "<script>" })), valid);
  });

  it("rejects anything that isn't a well-formed event", () => {
    const bad: unknown[] = [
      "not json",
      "",
      "null",
      "[]",
      "42",
      { ...valid, id: "7" },
      { ...valid, id: 0 },
      { ...valid, id: -1 },
      { ...valid, id: 1.5 },
      { ...valid, id: 2 ** 60 },
      { ...valid, deviceId: 5 },
      { ...valid, kind: 1 },
      { ...valid, payload: null },
      { ...valid, payload: [] },
      { ...valid, payload: "x" },
      { ...valid, createdAt: "yesterday" },
      { ...valid, createdAt: 1 },
    ];
    for (const input of bad) {
      const data = typeof input === "string" ? input : JSON.stringify(input);
      assert.equal(parseEvent(data), null, data);
    }
  });
});

describe("matchesFilter", () => {
  const e = stateEvent(1, DW, "runState.currentState", "INITIAL", "RUNNING");
  it("matches on device and kind, with empty filters matching everything", () => {
    assert.ok(matchesFilter(e, {}));
    assert.ok(matchesFilter(e, { deviceId: DW }));
    assert.ok(matchesFilter(e, { deviceId: DW, kind: "event" }));
    assert.ok(!matchesFilter(e, { deviceId: FRIDGE }));
    assert.ok(!matchesFilter(e, { kind: "control" }));
  });
});

describe("summarizeEvent", () => {
  it("describes a single state change", () => {
    assert.deepEqual(summarizeEvent(stateEvent(1, DW, "runState.currentState", "RUNNING", "END")), {
      title: "State changed",
      lines: ["runState.currentState: RUNNING → END"],
      more: 0,
    });
  });

  it("counts several changes and shows absent values as a dash", () => {
    const e = stateEvent(1, DW, "a.b", 1, 2);
    e.payload.changes = [
      { path: "a.b", from: 1, to: 2 },
      { path: "temperature[FREEZER]", from: null, to: { locationName: "FREEZER", targetTemperature: -18 } },
    ];
    const s = summarizeEvent(e);
    assert.equal(s.title, "State changed (2 values)");
    assert.deepEqual(s.lines, ["a.b: 1 → 2", 'temperature[FREEZER]: — → {"locationName":"FREEZER","targetTemperature":-18}']);
  });

  it("limits the lines shown and says how many more there are", () => {
    const e = stateEvent(1, DW, "a.b", 1, 2);
    e.payload.changes = Array.from({ length: 9 }, (_, i) => ({ path: `r.p${i}`, from: i, to: i + 1 }));
    const s = summarizeEvent(e, 4);
    assert.equal(s.lines.length, 4);
    assert.equal(s.more, 5);
  });

  it("flags lists the server truncated", () => {
    const e = stateEvent(1, DW, "a.b", 1, 2);
    e.payload.truncated = true;
    const s = summarizeEvent(e);
    assert.equal(s.title, "State changed (many values)");
    assert.equal(s.more, 1);
  });

  it("ignores malformed change entries", () => {
    const e = stateEvent(1, DW, "a.b", 1, 2);
    e.payload.changes = [null, 5, { path: 3 }, { nopath: true }, { path: "ok.path", from: 1, to: 2 }];
    assert.deepEqual(changesOf(e).map((c) => c.path), ["ok.path"]);
    e.payload.changes = "nope";
    assert.deepEqual(summarizeEvent(e).lines, []);
  });

  it("describes a command", () => {
    const s = summarizeEvent(controlEvent(2, FRIDGE, { temperature: { locationName: "FREEZER", targetTemperature: -21, unit: "C" } }));
    assert.equal(s.title, "Command sent");
    assert.deepEqual(s.lines, ["temperature[FREEZER].targetTemperature = -21", "temperature[FREEZER].unit = C"]);
  });

  it("falls back to the raw kind for unknown events", () => {
    assert.deepEqual(summarizeEvent({ id: 1, deviceId: DW, kind: "push", payload: {}, createdAt: "2026-01-01T00:00:00Z" }), {
      title: "push",
      lines: [],
      more: 0,
    });
  });
});

describe("formatValue", () => {
  it("renders values on one short line", () => {
    assert.equal(formatValue(null), "—");
    assert.equal(formatValue(undefined), "—");
    assert.equal(formatValue(true), "true");
    assert.equal(formatValue(-18), "-18");
    assert.equal(formatValue("END"), "END");
    assert.equal(formatValue("a\n\tb  c"), "a b c");
    assert.equal(formatValue({ a: [1] }), '{"a":[1]}');
    const long = formatValue("x".repeat(500));
    assert.equal(long.length, 80);
    assert.ok(long.endsWith("…"));
  });

  it("copes with values JSON can't serialise", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(formatValue(circular), "[object Object]");
    assert.equal(formatValue(10n), "10");
  });
});

describe("flattenCommand", () => {
  it("flattens nested commands into path = value lines", () => {
    assert.deepEqual(flattenCommand({ operation: { dishWasherOperationMode: "START" }, powerSave: { powerSaveEnabled: true } }), [
      "operation.dishWasherOperationMode = START",
      "powerSave.powerSaveEnabled = true",
    ]);
  });

  it("stops at a sane depth", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    const [line] = flattenCommand(deep);
    assert.equal(line.split(" = ")[0].split(".").length, 6);
  });
});

describe("applyReport", () => {
  const fridge = () => ({
    temperature: [
      { locationName: "FRIDGE", targetTemperature: 3, unit: "C" },
      { locationName: "FREEZER", targetTemperature: -18, unit: "C" },
    ],
    powerSave: { powerSaveEnabled: false },
    runState: { currentState: "INITIAL" },
  });

  it("merges changed properties into the state", () => {
    const next = applyReport(fridge(), { powerSave: { powerSaveEnabled: true }, runState: { currentState: "RUNNING" } });
    assert.deepEqual(next.powerSave, { powerSaveEnabled: true });
    assert.deepEqual(next.runState, { currentState: "RUNNING" });
    assert.deepEqual(next.temperature, fridge().temperature);
  });

  it("merges location entries by name and adds new ones", () => {
    const next = applyReport(fridge(), {
      temperature: [
        { locationName: "FREEZER", targetTemperature: -21 },
        { locationName: "CONVERTIBLE", targetTemperature: 0 },
      ],
    });
    assert.deepEqual(next.temperature, [
      { locationName: "FRIDGE", targetTemperature: 3, unit: "C" },
      { locationName: "FREEZER", targetTemperature: -21, unit: "C" },
      { locationName: "CONVERTIBLE", targetTemperature: 0 },
    ]);
    // An empty entry list (all reported entries were removals) changes nothing.
    assert.deepEqual(applyReport(fridge(), { temperature: [] }).temperature, fridge().temperature);
  });

  it("removes values reported as null and replaces other values", () => {
    const next = applyReport({ a: { x: 1, y: 2 }, list: [1, 2], gone: { z: 1 } }, { a: { y: null }, list: [3], gone: null, added: "new" });
    assert.deepEqual(next, { a: { x: 1 }, list: [3], added: "new" });
  });

  it("does not modify its inputs", () => {
    const state = fridge();
    const report = { temperature: [{ locationName: "FREEZER", targetTemperature: -21 }] };
    const next = applyReport(state, report);
    assert.deepEqual(state, fridge());
    (next.temperature as { targetTemperature: number }[])[1].targetTemperature = 99;
    assert.equal(report.temperature[0].targetTemperature, -21);
  });

  it("treats __proto__ keys as data", () => {
    const next = applyReport({}, JSON.parse('{"__proto__": {"polluted": true}, "a": {"__proto__": {"x": 1}}}'));
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf(next), Object.prototype);
    assert.ok(Object.hasOwn(next, "__proto__"));
  });
});

describe("formatTime", () => {
  it("shows only the time for today and the date otherwise", () => {
    const now = new Date("2026-01-01T12:00:00");
    const today = formatTime(new Date("2026-01-01T09:05:07").toISOString(), now);
    const earlier = formatTime(new Date("2025-12-30T09:05:07").toISOString(), now);
    assert.match(today, /05/);
    assert.ok(!today.includes("2025") && !today.includes("2026"));
    assert.match(earlier, /2025/);
  });

  it("returns input it can't parse unchanged", () => {
    assert.equal(formatTime("garbage"), "garbage");
  });
});
