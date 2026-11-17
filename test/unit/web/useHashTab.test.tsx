import "../../helpers/dom.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useHashTab } from "../../../src/web/useHashTab.js";

const TABS = ["home", "events", "settings"] as const;
const render = () => renderHook(() => useHashTab(TABS, "home"));

describe("useHashTab", () => {
  beforeEach(() => window.history.replaceState(null, "", "/app?x=1"));
  afterEach(cleanup);

  it("starts on the fallback tab without a hash, or on the tab the hash names", () => {
    assert.equal(render().result.current[0], "home");
    cleanup();
    window.history.replaceState(null, "", "/app?x=1#settings");
    assert.equal(render().result.current[0], "settings");
  });

  it("ignores hashes that are not tabs", () => {
    window.history.replaceState(null, "", "/app#nope");
    assert.equal(render().result.current[0], "home");
  });

  it("puts other tabs in the hash and drops it for the fallback, keeping path and query", () => {
    const { result } = render();
    act(() => result.current[1]("events"));
    assert.equal(result.current[0], "events");
    assert.equal(window.location.pathname + window.location.search + window.location.hash, "/app?x=1#events");
    act(() => result.current[1]("home"));
    assert.equal(result.current[0], "home");
    assert.equal(window.location.pathname + window.location.search + window.location.hash, "/app?x=1");
  });

  it("adds one history entry per switch, none for the current tab", () => {
    const { result } = render();
    const start = window.history.length;
    act(() => result.current[1]("home"));
    assert.equal(window.history.length, start);
    act(() => result.current[1]("events"));
    assert.equal(window.history.length, start + 1);
  });

  it("follows the Back button", async () => {
    const { result } = render();
    act(() => result.current[1]("events"));
    act(() => result.current[1]("settings"));
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.equal(result.current[0], "events");
  });
});
