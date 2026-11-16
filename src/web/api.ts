export interface Device {
  id: string;
  type: string;
  alias: string;
  modelName: string | null;
  reportable: boolean | null;
  updatedAt: string;
}

export interface User {
  id: number;
  username: string;
}

/** One changed value in a state-change event. */
export interface StateChange {
  path: string;
  from: unknown;
  to: unknown;
}

export type EventKind = "event" | "control";

/** A stored device event: a state change ("event") or a command sent ("control"). */
export interface DeviceEvent {
  id: number;
  deviceId: string | null;
  kind: EventKind | (string & {});
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Subscription {
  deviceId: string;
  alias: string;
  type: string;
  createdAt: string;
  createdBy: string | null;
  lastPolledAt: string | null;
  lastChangeAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface PollerStatus {
  state: "idle" | "paused" | "stopped";
  intervalMs: number;
  resumesAt: string | null;
  lastCycleAt: string | null;
  lastError: string | null;
}

export interface SubscriptionsResponse {
  poller: PollerStatus;
  subscriptions: Subscription[];
}

export interface EventFilter {
  deviceId?: string;
  kind?: EventKind;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Called when the server rejects a request because the session is gone. */
let onUnauthorized: (() => void) | undefined;

export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

/** Report a session that ended outside a normal API call (e.g. the event stream). */
export function notifyUnauthorized() {
  onUnauthorized?.();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin", // carry the session cookie
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // An expired session on a normal call should bounce the user to the login
    // page; a rejected login is handled by the login form itself.
    if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized?.();
    throw new ApiError(data?.error ?? data?.message ?? `${res.status} ${res.statusText}`, res.status);
  }
  return data as T;
}

export const api = {
  /** Current user, or null when not signed in. */
  me: async (): Promise<User | null> => {
    try {
      const { user } = await request<{ user: User }>("/api/auth/me");
      return user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
  login: async (username: string, password: string): Promise<User> => {
    const { user } = await request<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return user;
  },
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),

  devices: () => request<Device[]>("/api/devices"),
  syncDevices: () => request<Device[]>("/api/devices/sync", { method: "POST" }),
  status: (id: string) => request<Record<string, unknown>>(`/api/devices/${id}/status`),
  control: (id: string, command: Record<string, unknown>) =>
    request(`/api/devices/${id}/control`, { method: "POST", body: JSON.stringify(command) }),

  subscriptions: () => request<SubscriptionsResponse>("/api/subscriptions"),
  subscribe: (id: string) => request<Subscription>(`/api/devices/${encodeURIComponent(id)}/subscription`, { method: "PUT" }),
  unsubscribe: (id: string) =>
    request<null>(`/api/devices/${encodeURIComponent(id)}/subscription`, { method: "DELETE" }),
  /**
   * Event history, newest first. Page backwards with `before` = the smallest
   * id seen, or jump with `offset` (pinned below a fixed id by `before`).
   */
  events: (query: EventFilter & { before?: number; offset?: number; limit?: number } = {}) =>
    request<DeviceEvent[]>(`/api/events${eventQuery(query)}`),
  /** How many events match (same filters as `events`). */
  countEvents: (query: EventFilter & { before?: number } = {}) =>
    request<{ total: number }>(`/api/events/count${eventQuery(query)}`),
};

function eventQuery(query: EventFilter & { before?: number; offset?: number; limit?: number }): string {
  const params = new URLSearchParams();
  if (query.deviceId) params.set("deviceId", query.deviceId);
  if (query.kind) params.set("kind", query.kind);
  if (query.before !== undefined) params.set("before", String(query.before));
  if (query.offset) params.set("offset", String(query.offset));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Where the browser opens the live event stream (Server-Sent Events). */
export const EVENT_STREAM_URL = "/api/events/stream";
