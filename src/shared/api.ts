/**
 * The data the HTTP API sends, shared by the server (which produces it) and
 * the browser (which reads it), so the two can't drift apart.
 *
 * Types with timestamps take the type of time as a parameter: the server
 * works with `Date`, which JSON turns into an ISO 8601 string, so the default
 * (`string`) is what the browser receives.
 *
 * Types only: this file must not import anything or contain runtime code.
 */

export type EventKind = "event" | "control";

/** The signed-in user (`/api/auth/me`, `/api/auth/login`). */
export interface User {
  id: number;
  username: string;
}

/** A device from the local database (`/api/devices`). */
export interface Device<Time = string> {
  /** ThinQ's deviceId. */
  id: string;
  /** e.g. DEVICE_WASHER */
  type: string;
  alias: string;
  modelName: string | null;
  reportable: boolean | null;
  /** The device entry exactly as ThinQ sent it. */
  raw: Record<string, unknown> | null;
  updatedAt: Time;
}

/** One changed value in a state-change event. */
export interface StateChange {
  /** e.g. `runState.currentState` or `temperature[FREEZER].targetTemperature`. */
  path: string;
  /** Previous value; null when the value did not exist. */
  from: unknown;
  /** New value; null when the value was removed. */
  to: unknown;
}

/** A stored device event: a state change ("event") or a command sent ("control"). */
export interface DeviceEvent<Time = string> {
  id: number;
  deviceId: string | null;
  kind: EventKind | (string & {});
  payload: Record<string, unknown>;
  createdAt: Time;
}

/** A device watched for state changes. */
export interface Subscription<Time = string> {
  deviceId: string;
  alias: string;
  type: string;
  createdAt: Time;
  /** Username of who subscribed it; null once that user is gone. */
  createdBy: string | null;
  lastPolledAt: Time | null;
  lastChangeAt: Time | null;
  lastError: string | null;
  lastErrorAt: Time | null;
}

export type PollerState = "idle" | "paused" | "stopped";

export interface PollerStatus<Time = string> {
  state: PollerState;
  intervalMs: number;
  /** While paused: when polling resumes. */
  resumesAt: Time | null;
  lastCycleAt: Time | null;
  /** Why polling is paused (account/service-level problem). */
  lastError: string | null;
}

/** `GET /api/subscriptions` */
export interface SubscriptionsResponse<Time = string> {
  poller: PollerStatus<Time>;
  subscriptions: Subscription<Time>[];
}
