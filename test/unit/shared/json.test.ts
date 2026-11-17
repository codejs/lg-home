import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isObject, own, setOwn, type Json } from "../../../src/shared/json.js";

describe("shared JSON helpers", () => {
  it("isObject accepts plain objects only", () => {
    assert.equal(isObject({}), true);
    assert.equal(isObject(Object.create(null)), true);
    for (const v of [null, undefined, [], "x", 1, true]) assert.equal(isObject(v), false, String(v));
  });

  it("own ignores inherited properties", () => {
    const data: Json = JSON.parse('{"alias":"Fridge"}');
    assert.equal(own(data, "alias"), "Fridge");
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.equal(own(data, key), undefined, key);
    assert.equal(own(JSON.parse('{"__proto__":{"x":1}}'), "__proto__") !== undefined, true, "a real __proto__ key is data");
  });

  it("setOwn stores __proto__ as a plain key without touching the prototype", () => {
    const obj: Json = {};
    setOwn(obj, "__proto__", { polluted: true });
    assert.equal(Object.getPrototypeOf(obj), Object.prototype);
    assert.deepEqual(Object.keys(obj), ["__proto__"]);
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
    setOwn(obj, "a", 1);
    assert.equal(obj.a, 1);
  });
});
