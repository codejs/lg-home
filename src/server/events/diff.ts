/**
 * Compare two ThinQ device states and describe what changed.
 *
 * ThinQ states are JSON objects of resources (`runState`, `temperature`, ...).
 * Most resources are plain objects; parts of an appliance (fridge vs freezer)
 * come as arrays of entries keyed by `locationName`, which are matched by name
 * rather than by position.
 *
 * The result has two views of the same change:
 *   - `report`: the changed part of the new state, shaped like a ThinQ state
 *     (and like the partial reports ThinQ pushes for device events);
 *   - `changes`: one `{ path, from, to }` entry per changed value, for display.
 *
 * Input comes from an external service, so this is defensive: keys are read as
 * own properties only and written with defineProperty (no prototype pollution
 * via a `__proto__` key), nesting and the number of changes are bounded.
 * Callers should vet states with `checkState` first, which bounds their size
 * and depth before they are diffed, cloned or stored.
 */

import type { StateChange } from "../../shared/api.js";
import { isObject, own, setOwn, type Json } from "../../shared/json.js";

export { isObject, type Json };

/** One changed value (the API's StateChange). */
export type Change = StateChange;

export interface StateDiff {
  report: Json;
  changes: Change[];
  /** Set when there were more changes than `maxChanges`; `changes` is cut short. */
  truncated?: true;
}

export interface DiffLimits {
  /** Paths have at most this many segments; deeper values are compared as a whole. */
  maxDepth?: number;
  /** At most this many entries in `changes`. */
  maxChanges?: number;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_CHANGES = 200;

/** What changed from `prev` to `next`, or null when nothing did. */
export function diffState(prev: Json, next: Json, limits: DiffLimits = {}): StateDiff | null {
  const ctx: Context = {
    changes: [],
    truncated: false,
    maxDepth: limits.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxChanges: limits.maxChanges ?? DEFAULT_MAX_CHANGES,
  };
  const report = diffObjects(prev, next, "", 0, ctx);
  if (!report) return null;
  return { report, changes: ctx.changes, ...(ctx.truncated ? { truncated: true as const } : {}) };
}

interface Context {
  changes: Change[];
  truncated: boolean;
  maxDepth: number;
  maxChanges: number;
}

/** Returns the changed part of `next`, or null when equal. */
function diffObjects(prev: Json, next: Json, path: string, depth: number, ctx: Context): Json | null {
  let report: Json | null = null;
  for (const key of unionKeys(prev, next)) {
    const childPath = path ? `${path}.${key}` : key;
    const a = own(prev, key);
    const b = own(next, key);
    const changed = diffValues(a, b, childPath, depth + 1, ctx);
    if (changed === UNCHANGED) continue;
    report ??= {};
    setOwn(report, key, changed);
  }
  return report;
}

const UNCHANGED = Symbol("unchanged");

/** Returns the report value for this key, or UNCHANGED. */
function diffValues(a: unknown, b: unknown, path: string, depth: number, ctx: Context): unknown {
  if (depth < ctx.maxDepth) {
    if (isObject(a) && isObject(b)) {
      return diffObjects(a, b, path, depth, ctx) ?? UNCHANGED;
    }
    if (isLocated(a) && isLocated(b)) {
      return diffLocated(a, b, path, depth, ctx) ?? UNCHANGED;
    }
  }
  if (deepEqual(a, b)) return UNCHANGED;
  record(ctx, { path, from: a ?? null, to: b ?? null });
  return b === undefined ? null : structuredClone(b);
}

/** Arrays of `{ locationName, ... }` entries, matched by name. */
function diffLocated(prev: Json[], next: Json[], path: string, depth: number, ctx: Context): Json[] | null {
  const report: Json[] = [];
  let changed = false;
  const before = new Map(prev.map((e) => [e.locationName as string, e]));
  const after = new Map(next.map((e) => [e.locationName as string, e]));

  for (const [name, entry] of after) {
    const entryPath = `${path}[${name}]`;
    const old = before.get(name);
    if (!old) {
      changed = true;
      record(ctx, { path: entryPath, from: null, to: entry });
      report.push(structuredClone(entry));
      continue;
    }
    const entryChanges = diffObjects(old, entry, entryPath, depth, ctx);
    if (entryChanges) {
      changed = true;
      const out: Json = {};
      setOwn(out, "locationName", name);
      for (const [k, v] of Object.entries(entryChanges)) setOwn(out, k, v);
      report.push(out);
    }
  }
  // A removed entry has no representation in a ThinQ-style report, but it is a change.
  for (const [name, entry] of before) {
    if (after.has(name)) continue;
    changed = true;
    record(ctx, { path: `${path}[${name}]`, from: entry, to: null });
  }
  return changed ? report : null;
}

function record(ctx: Context, change: Change): void {
  if (ctx.changes.length >= ctx.maxChanges) {
    ctx.truncated = true;
    return;
  }
  ctx.changes.push({ path: change.path, from: structuredClone(change.from), to: structuredClone(change.to) });
}

// ---------------------------------------------------------------------------

export const MAX_STATE_DEPTH = 32;
export const MAX_STATE_BYTES = 256 * 1024;

/**
 * Why a device state can't be used, or null when it is fine: it must be a JSON
 * object nested at most MAX_STATE_DEPTH levels and at most MAX_STATE_BYTES as
 * JSON. Real ThinQ states are a few levels deep and a few KB. Iterative, so
 * hostile input can't overflow the stack.
 */
export function checkState(state: unknown): string | null {
  if (!isObject(state)) return "device state is not a JSON object";
  const stack: [unknown, number][] = [[state, 1]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop()!;
    if (typeof value !== "object" || value === null) continue;
    if (depth > MAX_STATE_DEPTH) return `device state is nested deeper than ${MAX_STATE_DEPTH} levels`;
    for (const child of Object.values(value)) stack.push([child, depth + 1]);
  }
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) return `device state is larger than ${MAX_STATE_BYTES} bytes`;
  return null;
}

function isLocated(v: unknown): v is Json[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  const names = new Set<string>();
  for (const e of v) {
    if (!isObject(e) || typeof own(e, "locationName") !== "string") return false;
    names.add(e.locationName as string);
  }
  return names.size === v.length; // duplicate names can't be matched; compare whole
}


function unionKeys(a: Json, b: Json): string[] {
  const keys = Object.keys(b);
  for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) keys.push(k);
  return keys;
}

/**
 * Structural equality for JSON values; object key order does not matter.
 * Iterative, so arbitrarily deep input can't overflow the stack.
 */
export function deepEqual(x: unknown, y: unknown): boolean {
  const stack: [unknown, unknown][] = [[x, y]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    if (a === b) continue;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      const bb = b as unknown[];
      if (a.length !== bb.length) return false;
      for (let i = 0; i < a.length; i++) stack.push([a[i], bb[i]]);
      continue;
    }
    const ao = a as Json;
    const bo = b as Json;
    const keys = Object.keys(ao);
    if (keys.length !== Object.keys(bo).length) return false;
    for (const k of keys) {
      if (!Object.hasOwn(bo, k)) return false;
      stack.push([ao[k], bo[k]]);
    }
  }
  return true;
}
