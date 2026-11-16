/**
 * Test doubles for the web app: a stateful fake of the server API behind
 * fetch, a controllable EventSource, and a render helper with a fresh query
 * client per test.
 */
import type { ReactElement } from "react";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Device, DeviceEvent, PollerStatus, Subscription } from "../../src/web/api";
import type { EventSourceLike } from "../../src/web/events/stream";

export const DW = "dw-1";
export const FRIDGE = "fridge-1";
export const T0 = Date.parse("2026-01-01T09:00:00Z");
export const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

export const devices = (): Device[] => [
  { id: DW, type: "DEVICE_DISH_WASHER", alias: "Dishwasher", modelName: "DFB532FP", reportable: true, updatedAt: iso(0) },
  { id: FRIDGE, type: "DEVICE_REFRIGERATOR", alias: "Kitchen Fridge", modelName: "GBB92STAXP", reportable: true, updatedAt: iso(0) },
];

export function stateEvent(id: number, deviceId: string, path: string, from: unknown, to: unknown, minutes = id): DeviceEvent {
  const [resource, prop] = path.split(".");
  return {
    id,
    deviceId,
    kind: "event",
    createdAt: iso(minutes),
    payload: { source: "poll", report: { [resource]: { [prop]: to } }, changes: [{ path, from, to }] },
  };
}

export function controlEvent(id: number, deviceId: string, command: Record<string, unknown>, minutes = id): DeviceEvent {
  return { id, deviceId, kind: "control", createdAt: iso(minutes), payload: command };
}

export interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Reply = { status: number; body?: unknown };

/** A fake of the server API: enough state to behave like the real one. */
export class FakeBackend {
  user: { id: number; username: string } | null = { id: 1, username: "alice" };
  devices = devices();
  subscriptions: Subscription[] = [];
  events: DeviceEvent[] = [];
  statuses: Record<string, Record<string, unknown>> = {
    [DW]: { runState: { currentState: "INITIAL" }, timer: { remainHour: 0, remainMinute: 0 } },
    [FRIDGE]: { powerSave: { powerSaveEnabled: false } },
  };
  poller: PollerStatus = { state: "idle", intervalMs: 60_000, resumesAt: null, lastCycleAt: null, lastError: null };
  requests: Request[] = [];
  private failures = new Map<string, Reply>();

  constructor() {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      this.requests.push({ method, path: url.pathname, query: url.searchParams, body });
      const reply = this.failures.get(`${method} ${url.pathname}`) ?? this.handle(method, url, body);
      return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? null), {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  /** Make a route answer with an error until cleared. */
  fail(route: string, status: number, error: string) {
    this.failures.set(route, { status, body: { error } });
  }
  clearFailures() {
    this.failures.clear();
  }

  subscribe(deviceId: string, extra: Partial<Subscription> = {}) {
    const d = this.devices.find((x) => x.id === deviceId)!;
    this.subscriptions.push({
      deviceId,
      alias: d.alias,
      type: d.type,
      createdAt: iso(0),
      createdBy: "alice",
      lastPolledAt: iso(1),
      lastChangeAt: null,
      lastError: null,
      lastErrorAt: null,
      ...extra,
    });
  }

  count(method: string, path: string) {
    return this.requests.filter((r) => r.method === method && r.path === path).length;
  }

  /** The last request to a path. */
  last(path: string) {
    return this.requests.filter((r) => r.path === path).at(-1)!;
  }

  private handle(method: string, url: URL, body: unknown): Reply {
    const path = url.pathname;
    if (path === "/api/auth/me") return this.user ? { status: 200, body: { user: this.user } } : { status: 401, body: { error: "Authentication required" } };
    if (!this.user) return { status: 401, body: { error: "Authentication required" } };
    if (method === "POST" && path === "/api/auth/logout") {
      this.user = null;
      return { status: 200, body: { ok: true } };
    }
    if (method === "GET" && path === "/api/devices") return { status: 200, body: this.devices };
    if (method === "POST" && path === "/api/devices/sync") return { status: 200, body: this.devices };
    if (method === "GET" && path === "/api/subscriptions") {
      return { status: 200, body: { poller: this.poller, subscriptions: this.subscriptions } };
    }
    if (method === "GET" && (path === "/api/events" || path === "/api/events/count")) {
      const q = url.searchParams;
      const before = q.get("before") ? Number(q.get("before")) : Infinity;
      const matching = this.events
        .filter((e) => (!q.get("deviceId") || e.deviceId === q.get("deviceId")) && (!q.get("kind") || e.kind === q.get("kind")) && e.id < before)
        .sort((a, b) => b.id - a.id);
      if (path === "/api/events/count") return { status: 200, body: { total: matching.length } };
      const offset = Number(q.get("offset") ?? 0);
      const limit = Number(q.get("limit") ?? 50);
      return { status: 200, body: matching.slice(offset, offset + limit) };
    }
    let m = /^\/api\/devices\/([^/]+)\/subscription$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const device = this.devices.find((d) => d.id === id);
      if (!device) return { status: 404, body: { error: "Unknown device" } };
      if (method === "PUT") {
        const existing = this.subscriptions.find((s) => s.deviceId === id);
        if (!existing) this.subscribe(id, { lastPolledAt: null });
        return { status: existing ? 200 : 201, body: this.subscriptions.find((s) => s.deviceId === id) };
      }
      if (method === "DELETE") {
        this.subscriptions = this.subscriptions.filter((s) => s.deviceId !== id);
        return { status: 204 };
      }
    }
    m = /^\/api\/devices\/([^/]+)\/status$/.exec(path);
    if (m && method === "GET") return { status: 200, body: this.statuses[decodeURIComponent(m[1])] ?? {} };
    return { status: 404, body: { error: `no fake route for ${method} ${path} ${JSON.stringify(body ?? null)}` } };
  }
}

/** A controllable stand-in for the browser's EventSource. */
export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  static get latest() {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
  static reset() {
    FakeEventSource.instances = [];
  }

  readyState = 0;
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

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  open() {
    act(() => {
      this.readyState = 1;
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
      this.readyState = 0;
      this.onerror?.(new Event("error"));
    });
  }

  /** The stream failed for good (e.g. the server answered 401). */
  fail() {
    act(() => {
      this.readyState = 2;
      this.onerror?.(new Event("error"));
    });
  }
}

export const fakeEventSource = (url: string) => new FakeEventSource(url);

export function newQueryClient() {
  // gcTime Infinity: no garbage-collection timers left running after a test.
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
}

export function renderWithClient(ui: ReactElement, queryClient = newQueryClient()) {
  const result = render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return { ...result, queryClient };
}
