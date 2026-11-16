/**
 * Pure helpers for device events in the browser: parsing stream messages,
 * summarising events for display, and applying a state-change report to a
 * cached device status.
 *
 * Event data comes from the device (via ThinQ), so it is treated as untrusted:
 * it is validated before use, only ever rendered as text, and merged without
 * touching object prototypes.
 */
import type { DeviceEvent, EventFilter, StateChange } from "../api";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse one stream message into an event, or null when it isn't one. */
export function parseEvent(data: string): DeviceEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const { id, deviceId, kind, payload, createdAt } = value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return null;
  if (deviceId !== null && typeof deviceId !== "string") return null;
  if (typeof kind !== "string" || !isObject(payload) || typeof createdAt !== "string") return null;
  if (Number.isNaN(Date.parse(createdAt))) return null;
  return { id, deviceId, kind, payload, createdAt };
}

export function matchesFilter(event: DeviceEvent, filter: EventFilter): boolean {
  return (!filter.deviceId || event.deviceId === filter.deviceId) && (!filter.kind || event.kind === filter.kind);
}

/** The `changes` of a state-change event, ignoring malformed entries. */
export function changesOf(event: DeviceEvent): StateChange[] {
  const changes = event.payload.changes;
  if (!Array.isArray(changes)) return [];
  return changes.filter((c): c is StateChange => isObject(c) && typeof c.path === "string");
}

export interface EventSummary {
  title: string;
  /** One line per changed value or command property. */
  lines: string[];
  /** Lines left out (beyond `maxLines`), including ones the server truncated. */
  more: number;
}

export const MAX_SUMMARY_LINES = 6;

export function summarizeEvent(event: DeviceEvent, maxLines = MAX_SUMMARY_LINES): EventSummary {
  let title: string;
  let lines: string[];
  let hidden = 0;
  if (event.kind === "event") {
    const changes = changesOf(event);
    title = changes.length === 1 ? "State changed" : `State changed (${changes.length} values)`;
    lines = changes.map((c) => `${c.path}: ${formatValue(c.from)} → ${formatValue(c.to)}`);
    if (event.payload.truncated === true) {
      title = "State changed (many values)";
      hidden = 1; // the server kept only part of the list
    }
  } else if (event.kind === "control") {
    title = "Command sent";
    lines = flattenCommand(event.payload);
  } else {
    title = event.kind;
    lines = [];
  }
  const shown = lines.slice(0, maxLines);
  return { title, lines: shown, more: lines.length - shown.length + hidden };
}

const MAX_VALUE_LENGTH = 80;

/** A short, single-line rendering of a state value. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return truncate(value.replace(/\s+/g, " "));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return truncate(text);
}

function truncate(text: string): string {
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
}

/**
 * `{ operation: { mode: "START" } }` -> `["operation.mode = START"]`; location
 * entries are labelled by name: `temperature[FREEZER].targetTemperature = -21`.
 */
export function flattenCommand(command: Json): string[] {
  const lines: string[] = [];
  const walk = (value: unknown, path: string, depth: number) => {
    if (isObject(value) && depth < 6) {
      const location = typeof value.locationName === "string" ? value.locationName : undefined;
      const base = location !== undefined ? `${path}[${location}]` : path;
      for (const [key, child] of Object.entries(value)) {
        if (location !== undefined && key === "locationName") continue;
        walk(child, base ? `${base}.${key}` : key, depth + 1);
      }
      return;
    }
    lines.push(`${path} = ${formatValue(value)}`);
  };
  walk(command, "", 0);
  return lines;
}

// ---------------------------------------------------------------------------
// Applying reports to a cached status

const isLocated = (v: unknown): v is Json[] =>
  Array.isArray(v) && v.length > 0 && v.every((e) => isObject(e) && typeof e.locationName === "string");

/**
 * The device status after a state-change `report`: objects merge, location
 * entries merge by `locationName`, `null` removes a value, anything else
 * replaces. Returns a new object; `state` is not modified.
 */
export function applyReport(state: Json, report: Json): Json {
  const out = clone(state);
  mergeInto(out, report, 0);
  return out;
}

function mergeInto(target: Json, patch: Json, depth: number): void {
  for (const [key, value] of Object.entries(patch)) {
    const existing = Object.hasOwn(target, key) ? target[key] : undefined;
    if (value === null) {
      delete target[key];
    } else if (depth < 16 && isObject(value) && isObject(existing)) {
      mergeInto(existing, value, depth + 1);
    } else if (depth < 16 && Array.isArray(value) && isLocated(existing) && value.every((e) => isObject(e) && typeof e.locationName === "string")) {
      for (const entry of value as Json[]) {
        const match = existing.find((e) => e.locationName === entry.locationName);
        if (match) mergeInto(match, entry, depth + 1);
        else existing.push(clone(entry));
      }
    } else {
      setOwn(target, key, clone(value));
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Assign without ever invoking the `__proto__` setter. */
function setOwn(obj: Json, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A compact local date/time, with the date left out for today. */
export function formatTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
