import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { formatClock, formatFullTimestamp, formatTimestamp, userLocales } from "../../../src/web/time.js";
import { setBrowserLanguages } from "../../helpers/locale.js";

// Local times, so the expectations don't depend on the machine's time zone.
const MORNING = new Date(2026, 0, 1, 9, 5, 7);
const AFTERNOON = new Date(2026, 0, 1, 14, 5, 7);
const NOON = new Date(2026, 0, 1, 12, 0, 0);
/** ICU puts a (narrow) no-break space before AM/PM; compare with plain spaces. */
const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

describe("time formatting follows the browser's locale", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("formatClock: 12-hour for en-US, 24-hour for en-GB and de-DE", () => {
    assert.equal(plain(formatClock(AFTERNOON, ["en-US"])), "2:05 PM");
    assert.equal(plain(formatClock(MORNING, ["en-US"])), "9:05 AM");
    assert.equal(formatClock(AFTERNOON, ["en-GB"]), "14:05");
    assert.equal(formatClock(MORNING, ["de-DE"]), "9:05");
    assert.equal(formatClock(AFTERNOON.getTime(), ["en-GB"]), "14:05", "accepts epoch milliseconds");
  });

  it("formatTimestamp: time with seconds for today, in the same style as formatClock", () => {
    assert.equal(plain(formatTimestamp(AFTERNOON.toISOString(), NOON, ["en-US"])), "2:05:07 PM");
    assert.equal(formatTimestamp(AFTERNOON.toISOString(), NOON, ["en-GB"]), "14:05:07");
  });

  it("formatTimestamp: date and time for other days", () => {
    const earlier = new Date(2025, 11, 30, 9, 5, 7).toISOString();
    assert.equal(plain(formatTimestamp(earlier, NOON, ["en-US"])), "Dec 30, 2025, 9:05 AM");
    assert.equal(formatTimestamp(earlier, NOON, ["en-GB"]), "30 Dec 2025, 09:05");
  });

  it("leaves unparseable input unchanged", () => {
    assert.equal(formatTimestamp("garbage"), "garbage");
    assert.equal(formatFullTimestamp("garbage"), "garbage");
  });

  it("uses the browser's preferred languages by default", () => {
    restore = setBrowserLanguages("en-GB", "en");
    assert.deepEqual(userLocales(), ["en-GB", "en"]);
    assert.equal(formatClock(AFTERNOON), "14:05");
    assert.equal(formatTimestamp(AFTERNOON.toISOString(), NOON), "14:05:07");
    restore();

    restore = setBrowserLanguages("en-US");
    assert.equal(plain(formatClock(AFTERNOON)), "2:05 PM");
    assert.equal(plain(formatTimestamp(AFTERNOON.toISOString(), NOON)), "2:05:07 PM");
    assert.equal(plain(formatFullTimestamp(AFTERNOON.toISOString())), "1/1/2026, 2:05:07 PM");
  });

  it("falls back to navigator.language when languages is empty", () => {
    restore = setBrowserLanguages("de-DE");
    Object.defineProperty(globalThis.navigator, "languages", { value: [], configurable: true });
    assert.deepEqual(userLocales(), ["de-DE"]);
    assert.equal(formatClock(AFTERNOON), "14:05");
  });
});
