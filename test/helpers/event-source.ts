/**
 * A controllable stand-in for the browser's EventSource (neither happy-dom nor
 * Node has one). dom.ts installs it as the global EventSource, so anything that
 * opens the live event stream gets one that never touches the network; tests
 * drive it with open(), send(), drop() and fail().
 *
 * Uses React's own act() rather than Testing Library's: dom.ts imports this
 * before the DOM exists, and Testing Library must not be loaded before that.
 */
import { act } from "react";
import type { EventSourceLike } from "../../src/web/events/stream.js";

export class FakeEventSource implements EventSourceLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  static instances: FakeEventSource[] = [];
  static get latest() {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
  static reset() {
    FakeEventSource.instances = [];
  }

  readyState = FakeEventSource.CONNECTING;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  open() {
    act(() => {
      this.readyState = FakeEventSource.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  /** Deliver a default ("message") event; objects are sent as JSON. */
  send(data: unknown) {
    act(() => this.onmessage?.(new MessageEvent("message", { data: typeof data === "string" ? data : JSON.stringify(data) })));
  }

  sendNamed(type: string, data: unknown) {
    act(() => {
      for (const l of this.listeners.get(type) ?? []) l(new MessageEvent(type, { data: JSON.stringify(data) }));
    });
  }

  /** Connection dropped; the browser will reconnect by itself. */
  drop() {
    act(() => {
      this.readyState = FakeEventSource.CONNECTING;
      this.onerror?.(new Event("error"));
    });
  }

  /** The stream failed for good (e.g. the server answered 401). */
  fail() {
    act(() => {
      this.readyState = FakeEventSource.CLOSED;
      this.onerror?.(new Event("error"));
    });
  }
}

/** An EventSourceFactory for the app that hands out FakeEventSources. */
export const fakeEventSource = (url: string) => new FakeEventSource(url);
