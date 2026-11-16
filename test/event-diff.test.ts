/** Unit tests for the device-state diff behind state-change events. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_STATE_BYTES, MAX_STATE_DEPTH, checkState, deepEqual, diffState } from "../src/server/events/diff.js";

const fridge = () => ({
  doorStatus: [{ locationName: "MAIN", doorState: "CLOSE" }],
  temperature: [
    { locationName: "FRIDGE", targetTemperature: 3, unit: "C" },
    { locationName: "FREEZER", targetTemperature: -18, unit: "C" },
  ],
  powerSave: { powerSaveEnabled: false },
  refrigeration: { expressMode: false, freshAirFilter: "AUTO" },
});

describe("diffState", () => {
  it("returns null when nothing changed, regardless of key order", () => {
    assert.equal(diffState(fridge(), fridge()), null);
    const { doorStatus, temperature, powerSave } = fridge();
    const reordered = { refrigeration: { freshAirFilter: "AUTO", expressMode: false }, powerSave, temperature, doorStatus };
    assert.deepEqual(Object.keys(reordered), ["refrigeration", "powerSave", "temperature", "doorStatus"]);
    assert.equal(diffState(fridge(), reordered), null);
    assert.equal(diffState({}, {}), null);
  });

  it("reports a changed property of a plain resource", () => {
    const next = fridge();
    next.powerSave.powerSaveEnabled = true;
    assert.deepEqual(diffState(fridge(), next), {
      report: { powerSave: { powerSaveEnabled: true } },
      changes: [{ path: "powerSave.powerSaveEnabled", from: false, to: true }],
    });
  });

  it("only includes the changed properties of a resource in the report", () => {
    const next = fridge();
    next.refrigeration.freshAirFilter = "POWER";
    assert.deepEqual(diffState(fridge(), next)?.report, { refrigeration: { freshAirFilter: "POWER" } });
  });

  it("matches location-based entries by locationName, not position", () => {
    const next = fridge();
    next.temperature.reverse();
    assert.equal(diffState(fridge(), next), null, "reordering is not a change");

    next.temperature[0].targetTemperature = -21; // FREEZER, now first
    assert.deepEqual(diffState(fridge(), next), {
      report: { temperature: [{ locationName: "FREEZER", targetTemperature: -21 }] },
      changes: [{ path: "temperature[FREEZER].targetTemperature", from: -18, to: -21 }],
    });
  });

  it("reports added and removed location entries", () => {
    const next = fridge();
    next.temperature = [next.temperature[0], { locationName: "CONVERTIBLE", targetTemperature: 0, unit: "C" }];
    const diff = diffState(fridge(), next)!;
    assert.deepEqual(diff.report, { temperature: [{ locationName: "CONVERTIBLE", targetTemperature: 0, unit: "C" }] });
    assert.deepEqual(diff.changes, [
      { path: "temperature[CONVERTIBLE]", from: null, to: { locationName: "CONVERTIBLE", targetTemperature: 0, unit: "C" } },
      { path: "temperature[FREEZER]", from: { locationName: "FREEZER", targetTemperature: -18, unit: "C" }, to: null },
    ]);
  });

  it("reports a removed location entry even when nothing else changed", () => {
    const next = fridge();
    next.temperature = [next.temperature[0]];
    const diff = diffState(fridge(), next)!;
    assert.deepEqual(diff.report, { temperature: [] });
    assert.equal(diff.changes.length, 1);
    assert.equal(diff.changes[0].path, "temperature[FREEZER]");
  });

  it("reports added and removed resources and properties, using null for absent values", () => {
    const prev = { a: { x: 1 }, gone: { y: 2 } };
    const next = { a: { x: 1, z: "new" }, added: { w: true } };
    const diff = diffState(prev, next)!;
    assert.deepEqual(diff.report, { a: { z: "new" }, added: { w: true }, gone: null });
    assert.deepEqual(diff.changes, [
      { path: "a.z", from: null, to: "new" },
      { path: "added", from: null, to: { w: true } },
      { path: "gone", from: { y: 2 }, to: null },
    ]);
  });

  it("compares plain arrays and type changes as whole values", () => {
    assert.deepEqual(diffState({ list: [1, 2] }, { list: [1, 2, 3] })?.changes, [{ path: "list", from: [1, 2], to: [1, 2, 3] }]);
    assert.deepEqual(diffState({ v: { a: 1 } }, { v: "flat" })?.changes, [{ path: "v", from: { a: 1 }, to: "flat" }]);
    assert.deepEqual(diffState({ v: 0 }, { v: "0" })?.changes, [{ path: "v", from: 0, to: "0" }]);
    assert.deepEqual(diffState({ v: null }, { v: false })?.changes, [{ path: "v", from: null, to: false }]);
    // Arrays with duplicate location names can't be matched, so they compare whole.
    const dup = [
      { locationName: "A", v: 1 },
      { locationName: "A", v: 2 },
    ];
    assert.deepEqual(diffState({ r: dup }, { r: [dup[0], { locationName: "A", v: 3 }] })?.changes.map((c) => c.path), ["r"]);
  });

  it("reports the dishwasher finishing its programme", () => {
    const running = { runState: { currentState: "RUNNING" }, timer: { remainHour: 0, remainMinute: 1, totalHour: 2, totalMinute: 15 } };
    const done = { runState: { currentState: "END" }, timer: { remainHour: 0, remainMinute: 0, totalHour: 2, totalMinute: 15 } };
    assert.deepEqual(diffState(running, done), {
      report: { runState: { currentState: "END" }, timer: { remainMinute: 0 } },
      changes: [
        { path: "runState.currentState", from: "RUNNING", to: "END" },
        { path: "timer.remainMinute", from: 1, to: 0 },
      ],
    });
  });

  it("does not share objects with its inputs", () => {
    const prev = { r: { list: [1] } };
    const next = { r: { list: [2] } };
    const diff = diffState(prev, next)!;
    (diff.report.r as { list: number[] }).list.push(99);
    (diff.changes[0].to as number[]).push(99);
    assert.deepEqual(next, { r: { list: [2] } });
  });

  it("does not mutate its inputs", () => {
    const prev = fridge();
    const next = fridge();
    next.temperature[1].targetTemperature = -20;
    diffState(prev, next);
    assert.deepEqual(prev, fridge());
    assert.equal(next.temperature[1].targetTemperature, -20);
  });

  describe("hostile input", () => {
    it("treats __proto__ keys as data without polluting prototypes", () => {
      const prev = JSON.parse('{"__proto__": {"polluted": false}, "a": {"__proto__": {"x": 1}}}');
      const next = JSON.parse('{"__proto__": {"polluted": true}, "a": {"__proto__": {"x": 2}}}');
      const diff = diffState(prev, next)!;
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
      assert.equal(Object.getPrototypeOf(diff.report), Object.prototype);
      assert.ok(Object.hasOwn(diff.report, "__proto__"));
      assert.deepEqual(
        diff.changes.map((c) => [c.path, c.from, c.to]),
        [
          ["__proto__.polluted", false, true],
          ["a.__proto__.x", 1, 2],
        ],
      );
      // Survives a JSON round trip as data (as it does through the database).
      assert.deepEqual(JSON.parse(JSON.stringify(diff.report)).a, JSON.parse('{"__proto__": {"x": 2}}'));
    });

    it("does not read inherited properties as state", () => {
      const diff = diffState({}, JSON.parse('{"constructor": 1, "toString": "x"}'))!;
      assert.deepEqual(diff.changes, [
        { path: "constructor", from: null, to: 1 },
        { path: "toString", from: null, to: "x" },
      ]);
      assert.equal(diffState({}, { hasOwnProperty: undefined }), null);
    });

    it("stops descending past maxDepth and compares deeper values whole", () => {
      const deep = (leaf: number) => ({ a: { b: { c: { d: leaf } } } });
      assert.deepEqual(diffState(deep(1), deep(2), { maxDepth: 2 })?.changes, [
        { path: "a.b", from: { c: { d: 1 } }, to: { c: { d: 2 } } },
      ]);
      assert.deepEqual(diffState(deep(1), deep(2))?.changes.map((c) => c.path), ["a.b.c.d"]);
    });

    it("diffs states up to the accepted depth", () => {
      let a: Record<string, unknown> = { v: 1 };
      let b: Record<string, unknown> = { v: 2 };
      for (let i = 1; i < MAX_STATE_DEPTH; i++) {
        a = { n: a };
        b = { n: b };
      }
      assert.equal(checkState(a), null);
      const diff = diffState(a, b);
      assert.equal(diff?.changes.length, 1);
      assert.equal(diff?.changes[0].path.split(".").length, 8, "paths stop at the default maxDepth");
    });

    it("caps the number of changes but keeps the full report", () => {
      const prev = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`r${i}`, { v: 0 }]));
      const next = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`r${i}`, { v: 1 }]));
      const diff = diffState(prev, next, { maxChanges: 10 })!;
      assert.equal(diff.changes.length, 10);
      assert.equal(diff.truncated, true);
      assert.equal(Object.keys(diff.report).length, 50);
      assert.equal(diffState(prev, next)!.truncated, undefined);
    });

    it("still reports a change when the only change is past the cap", () => {
      const prev = { a: { v: 0 }, loc: [{ locationName: "X" }, { locationName: "Y" }] };
      const next = { a: { v: 1 }, loc: [{ locationName: "X" }] };
      const diff = diffState(prev, next, { maxChanges: 1 })!;
      assert.deepEqual(diff.changes.map((c) => c.path), ["a.v"]);
      assert.equal(diff.truncated, true);
      assert.deepEqual(diff.report.loc, [], "removal still shows up in the report");
    });
  });
});

describe("deepEqual", () => {
  it("compares JSON values structurally", () => {
    assert.ok(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] }));
    assert.ok(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));
    assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
    assert.ok(!deepEqual([1, 2], [2, 1]));
    assert.ok(!deepEqual([], {}));
    assert.ok(!deepEqual(null, {}));
    assert.ok(!deepEqual(1, "1"));
  });
});

describe("checkState", () => {
  const nested = (levels: number) => {
    let v: unknown = 1;
    for (let i = 0; i < levels; i++) v = { n: v };
    return v;
  };

  it("accepts ordinary device states", () => {
    assert.equal(checkState(fridge()), null);
    assert.equal(checkState({}), null);
  });

  it("rejects anything but a JSON object", () => {
    for (const bad of [null, undefined, 1, "state", [], [{}]]) {
      assert.match(checkState(bad) ?? "", /not a JSON object/, JSON.stringify(bad));
    }
  });

  it("rejects states nested too deeply, without overflowing the stack", () => {
    assert.equal(checkState(nested(MAX_STATE_DEPTH)), null);
    assert.match(checkState(nested(MAX_STATE_DEPTH + 1)) ?? "", /deeper than/);
    assert.match(checkState(nested(100_000)) ?? "", /deeper than/);
    // Arrays count as levels too.
    let arr: unknown = 1;
    for (let i = 0; i < MAX_STATE_DEPTH + 1; i++) arr = [arr];
    assert.match(checkState({ a: arr }) ?? "", /deeper than/);
  });

  it("rejects states that are too large", () => {
    assert.equal(checkState({ blob: "x".repeat(MAX_STATE_BYTES - 100) }), null);
    assert.match(checkState({ blob: "x".repeat(MAX_STATE_BYTES) }) ?? "", /larger than/);
    // Measured in bytes, not characters.
    assert.match(checkState({ blob: "é".repeat(MAX_STATE_BYTES / 2) }) ?? "", /larger than/);
  });
});
