/**
 * Turns raw ThinQ device state into something people can read.
 *
 * ThinQ state is a map of resources (`runState`, `temperature`, ...) holding
 * properties; resources tied to a part of the appliance are arrays of entries
 * with a `locationName`. Rather than special-casing each appliance, this module
 * recognises property names that ThinQ uses across device types, so unknown
 * appliances still get a sensible card.
 *
 * Everything here is pure (no React, no clock unless passed in) so it can be
 * unit-tested exhaustively.
 */

import { isObject, own, type Json } from "../shared/json";
import { formatClock } from "./time";

export type { Json };

// ---------------------------------------------------------------------------
// Labels

// Table lookups use own(): device data may contain keys like "constructor" or
// "toString", which must not resolve to Object.prototype.

/** Nicer names for well-known keys; anything else is derived from camelCase. */
const KEY_LABELS: Record<string, string> = {
  runState: "Status",
  currentState: "Status",
  doorStatus: "Door",
  doorState: "Door",
  temperature: "Temperature",
  targetTemperature: "Target temperature",
  currentTemperature: "Current temperature",
  remoteControlEnable: "Remote start",
  remoteControlEnabled: "Remote start",
  powerSave: "Power save",
  powerSaveEnabled: "Power save",
  ecoFriendly: "Eco",
  ecoFriendlyMode: "Eco mode",
  sabbath: "Sabbath",
  sabbathMode: "Sabbath mode",
  refrigeration: "Cooling",
  expressMode: "Express freeze",
  expressFridge: "Express cool",
  freshAirFilter: "Fresh air filter",
  waterFilterInfo: "Water filter",
  usedTime: "In use for",
  dishWashingStatus: "Washing",
  rinseRefill: "Rinse aid",
  preference: "Preferences",
  rinseLevel: "Rinse aid level",
  softeningLevel: "Water softening",
  dishWashingCourse: "Programme",
  currentDishWashingCourse: "Programme",
  timer: "Timer",
};

/** Labels for combined hour+minute timer fields, keyed by their shared name. */
const DURATION_LABELS: Record<string, string> = {
  remain: "Time left",
  total: "Programme length",
  relativeToStart: "Starts in",
  relativeToStop: "Stops in",
  running: "Running for",
};

/** Nicer names for common enum values; anything else is derived from SNAKE_CASE. */
const ENUM_LABELS: Record<string, string> = {
  POWER_OFF: "Off",
  POWER_ON: "On",
  INITIAL: "Ready",
  STANDBY: "Standby",
  RUNNING: "Running",
  PAUSE: "Paused",
  END: "Finished",
  ERROR: "Error",
  RESERVED: "Scheduled",
  OPEN: "Open",
  CLOSE: "Closed",
  CLOSED: "Closed",
};

const LOCATION_LABELS: Record<string, string> = {
  MAIN: "Main",
  FRIDGE: "Fridge",
  FREEZER: "Freezer",
  CONVERTIBLE: "Convertible",
};

const TYPE_LABELS: Record<string, string> = {
  DEVICE_REFRIGERATOR: "Refrigerator",
  DEVICE_KIMCHI_REFRIGERATOR: "Kimchi refrigerator",
  DEVICE_WINE_CELLAR: "Wine cellar",
  DEVICE_DISH_WASHER: "Dishwasher",
  DEVICE_WASHER: "Washer",
  DEVICE_DRYER: "Dryer",
  DEVICE_WASHTOWER: "WashTower",
  DEVICE_WASHTOWER_WASHER: "WashTower washer",
  DEVICE_WASHTOWER_DRYER: "WashTower dryer",
  DEVICE_STYLER: "Styler",
  DEVICE_AIR_CONDITIONER: "Air conditioner",
  DEVICE_SYSTEM_BOILER: "Boiler",
  DEVICE_AIR_PURIFIER: "Air purifier",
  DEVICE_AIR_PURIFIER_FAN: "Air purifier fan",
  DEVICE_DEHUMIDIFIER: "Dehumidifier",
  DEVICE_HUMIDIFIER: "Humidifier",
  DEVICE_CEILING_FAN: "Ceiling fan",
  DEVICE_OVEN: "Oven",
  DEVICE_COOKTOP: "Cooktop",
  DEVICE_HOOD: "Range hood",
  DEVICE_MICROWAVE_OVEN: "Microwave",
  DEVICE_ROBOT_CLEANER: "Robot vacuum",
  DEVICE_STICK_CLEANER: "Stick vacuum",
  DEVICE_WATER_HEATER: "Water heater",
  DEVICE_WATER_PURIFIER: "Water purifier",
  DEVICE_PLANT_CULTIVATOR: "Plant cultivator",
};

/** Words that should stay upper-case even when ThinQ writes them camelCase ("uvLamp"). */
const ACRONYMS = new Set(["uv", "ai", "pm", "pm1", "pm2", "pm10", "co2", "voc", "led", "id", "ac", "wifi"]);

/** "firstWordUpper" -> "First word upper"; keeps acronyms like "UV" intact. */
export function humanizeKey(key: string): string {
  const curated = own(KEY_LABELS, key);
  if (curated) return curated;
  // Families of keys that vary per appliance but mean the same thing.
  if (/^(airCon|airPurifier|humidifier|dehumidifier|airPurifierFan)OperationMode$/.test(key)) return "Power";
  if (/JobMode$/.test(key)) return "Mode";
  if (/Course$/.test(key)) return "Programme";
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return key;
  return words
    .map((w, i) => {
      if (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w; // acronym
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower === "wifi" ? "Wi-Fi" : lower.toUpperCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/** "POWER_OFF" -> "Off", "LEVEL_2" -> "Level 2", "AUTO" -> "Auto". */
export function humanizeEnum(value: string): string {
  const curated = own(ENUM_LABELS, value);
  if (curated) return curated;
  const text = value.replace(/_+/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function locationLabel(name: string): string {
  return own(LOCATION_LABELS, name) ?? humanizeEnum(name);
}

/** "DEVICE_DISH_WASHER" -> "Dishwasher"; unknown types are humanised. */
export function deviceTypeLabel(type: string): string {
  return own(TYPE_LABELS, type) ?? humanizeEnum(type.replace(/^DEVICE_/, ""));
}

// ---------------------------------------------------------------------------
// Values

const isEnumLike = (s: string) => /^[A-Z][A-Z0-9_]*$/.test(s);
const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** Number with a real minus sign, e.g. "−18". */
export function formatNumber(n: number): string {
  return NUMBER.format(n).replace(/^-/, "\u2212");
}

const UNIT_LABELS: Record<string, [singular: string, plural: string]> = {
  MONTH: ["month", "months"],
  DAY: ["day", "days"],
  HOUR: ["hour", "hours"],
  TIMES: ["time", "times"],
  PERCENT: ["%", "%"],
};

/** A number with its unit: °C/°F for temperatures, words for the rest. */
export function formatWithUnit(n: number, unit: unknown, key = ""): string {
  const num = formatNumber(n);
  if (unit === "C" || unit === "F") return `${num} °${unit}`;
  const unitWords = typeof unit === "string" ? own(UNIT_LABELS, unit) : undefined;
  if (unitWords) {
    const [one, many] = unitWords;
    return one === "%" ? `${num}%` : `${num} ${n === 1 ? one : many}`;
  }
  if (/temperature/i.test(key) && unit === undefined) return `${num}°`;
  return typeof unit === "string" && unit ? `${num} ${unit}` : num;
}

/** 75 -> "1 h 15 min", 45 -> "45 min", 120 -> "2 h". */
export function formatDuration(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0) return "—";
  const minutes = Math.round(totalMinutes);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Booleans whose true/false deserve words other than On/Off. */
const BOOLEAN_WORDS: Record<string, [whenTrue: string, whenFalse: string]> = {
  rinseRefill: ["Refill needed", "OK"],
};

export function formatValue(key: string, value: unknown, unit?: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") {
    const [yes, no] = own(BOOLEAN_WORDS, key) ?? ["On", "Off"];
    return value ? yes : no;
  }
  if (typeof value === "number") return Number.isFinite(value) ? formatWithUnit(value, unit, key) : "—";
  if (typeof value === "string") return isEnumLike(value) ? humanizeEnum(value) : value;
  if (Array.isArray(value)) {
    return value.length === 0 ? "—" : value.map((v) => formatValue(key, v)).join(", ");
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Full detail list

export interface DetailRow {
  label: string;
  value: string;
}

export interface DetailGroup {
  /** Empty for the untitled overview block. */
  title: string;
  rows: DetailRow[];
}

/**
 * Rows for one resource object: hour/minute pairs become one duration, a
 * `unit` sibling is folded into the numbers it qualifies, nested objects are
 * flattened as "Parent › child".
 */
function rowsFor(props: Json, prefix = ""): DetailRow[] {
  const rows: DetailRow[] = [];
  const used = new Set<string>();
  const unit = props.unit;
  const unitConsumed = Object.entries(props).some(([k, v]) => k !== "unit" && typeof v === "number");

  for (const [key, value] of Object.entries(props)) {
    if (used.has(key) || key === "locationName") continue;
    if (key === "unit" && unitConsumed) continue;

    // remainHour + remainMinute -> "Time left: 1 h 15 min"
    const hour = /^(.*)Hour(.*)$/.exec(key);
    if (hour && typeof value === "number") {
      const minuteKey = `${hour[1]}Minute${hour[2]}`;
      const minutes = props[minuteKey];
      if (typeof minutes === "number") {
        used.add(minuteKey);
        const name = hour[1] + hour[2];
        rows.push({ label: prefix + (own(DURATION_LABELS, name) ?? humanizeKey(name)), value: formatDuration(value * 60 + minutes) });
        continue;
      }
    }

    if (isObject(value)) {
      rows.push(...rowsFor(value, `${prefix}${humanizeKey(key)} › `));
    } else {
      rows.push({ label: prefix + humanizeKey(key), value: formatValue(key, value, unit) });
    }
  }
  return rows;
}

/** A one-row group whose row label already says what the heading would ("Eco" / "Eco mode"). */
function isSelfDescribing(group: DetailGroup): boolean {
  if (group.rows.length !== 1) return false;
  const title = group.title.toLowerCase();
  const label = group.rows[0].label.toLowerCase();
  return label.includes(title) || title.includes(label);
}

/**
 * Every property of a device state as readable rows, grouped by resource.
 * Single self-explanatory rows (and top-level scalars) are gathered into a
 * leading untitled overview group instead of each getting its own heading.
 */
export function describeState(state: Json): DetailGroup[] {
  const groups: DetailGroup[] = [];
  const overview: DetailRow[] = [];

  for (const [resource, value] of Object.entries(state)) {
    const title = humanizeKey(resource);
    let rows: DetailRow[];
    if (Array.isArray(value) && value.every(isObject)) {
      // Name the location only when there is more than one (fridge vs freezer).
      const named = value.length > 1;
      rows = value.flatMap((entry) =>
        rowsFor(entry, named && typeof entry.locationName === "string" ? `${locationLabel(entry.locationName)} · ` : ""),
      );
    } else if (isObject(value)) {
      rows = rowsFor(value);
    } else {
      overview.push({ label: title, value: formatValue(resource, value) });
      continue;
    }
    if (rows.length === 0) continue; // empty resource ({} or []): nothing to show
    const group = { title, rows };
    if (isSelfDescribing(group)) overview.push(group.rows[0]);
    else groups.push(group);
  }
  return overview.length ? [{ title: "", rows: overview }, ...groups] : groups;
}

// ---------------------------------------------------------------------------
// Paths (device events)

/** A path segment: `temperature[FREEZER]` -> key "temperature", location "FREEZER". */
interface PathSegment {
  key: string;
  location?: string;
}

function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  for (const m of path.matchAll(/([^.[\]]+)(?:\[([^\]]*)\])?/g)) {
    segments.push(m[2] === undefined ? { key: m[1] } : { key: m[1], location: m[2] });
  }
  return segments;
}

/** Like humanizeKey, but timer parts get the card's names: remainMinute -> "Time left (min)". */
function propertyLabel(key: string): string {
  const part = /^(.*)(Hour|Minute)(.*)$/.exec(key);
  const duration = part ? own(DURATION_LABELS, part[1] + part[3]) : undefined;
  if (duration) return `${duration} (${part![2] === "Hour" ? "h" : "min"})`;
  return humanizeKey(key);
}

/**
 * A readable name for a value in a device state, as device events address it
 * (`runState.currentState`, `temperature[FREEZER].targetTemperature`), using
 * the same words as the card's "All details": "Status", "Freezer · Target
 * temperature", "Timer › Time left (min)". The resource is left out when the
 * property already says it, as the card does for one-row groups.
 */
export function labelForPath(path: string): string {
  const [resource, ...props] = parsePath(path);
  if (!resource) return path;
  const title = humanizeKey(resource.key);
  const where = resource.location !== undefined ? `${locationLabel(resource.location)} · ` : "";
  if (props.length === 0) return where + title;
  const label = props
    .map((p) => (p.location !== undefined ? `${locationLabel(p.location)} · ` : "") + propertyLabel(p.key))
    .join(" › ");
  return isSelfDescribing({ title, rows: [{ label, value: "" }] }) ? where + label : `${title} › ${where}${label}`;
}

/** The last property named in a path (what a value is formatted as): `a.b[X].c` -> "c". */
export function pathKey(path: string): string {
  return parsePath(path).at(-1)?.key ?? path;
}

// ---------------------------------------------------------------------------
// At-a-glance summary

export type Tone = "active" | "paused" | "done" | "idle" | "off" | "error";

export interface DeviceSummary {
  /** Headline state for the pill, when the device reports one. */
  status?: { label: string; tone: Tone };
  /** The few numbers worth showing big (temperatures, time left, programme). */
  highlights: { label: string; value: string; hint?: string }[];
  /** Progress of a running cycle, in minutes. */
  progress?: { remaining: number; total: number };
  /** Things that need attention (door open, refill needed, ...). */
  alerts: string[];
  /** Modes and options that are switched on. */
  features: string[];
}

const STATE_TONES: Record<string, Tone> = {
  POWER_OFF: "off",
  SLEEP: "off",
  INITIAL: "idle",
  STANDBY: "idle",
  READY: "idle",
  RESERVED: "idle",
  PAUSE: "paused",
  END: "done",
  ERROR: "error",
  POWER_ON: "active",
};

function toneFor(state: string): Tone {
  const tone = own(STATE_TONES, state);
  if (tone) return tone;
  // RUNNING, WASHING, RINSING, SPINNING, DRYING, COOLING, COOKING, ...
  return /ING$|^RUN/.test(state) ? "active" : "idle";
}

/** A resource as a list of entries, whether ThinQ sent an object or a location array. */
function entries(value: unknown): Json[] {
  if (Array.isArray(value)) return value.filter(isObject);
  return isObject(value) ? [value] : [];
}

function minutes(timer: Json, name: "remain" | "total"): number | undefined {
  const h = timer[`${name}Hour`];
  const m = timer[`${name}Minute`];
  if (typeof h !== "number" && typeof m !== "number") return undefined;
  const total = (typeof h === "number" ? h : 0) * 60 + (typeof m === "number" ? m : 0);
  return Number.isFinite(total) ? total : undefined;
}

/** Boolean flags that are worth showing as "on" chips, with their chip text. */
const FEATURE_FLAG = /(Mode|Enabled|Fridge)$/;

/**
 * Pick the headline facts out of a device state. `now` is only used to say
 * when a running programme will finish.
 */
export function summarize(state: Json, now: Date = new Date()): DeviceSummary {
  const summary: DeviceSummary = { highlights: [], alerts: [], features: [] };

  // Status: runState.currentState, or an "...OperationMode" of POWER_ON/OFF (air conditioners).
  const runState = entries(state.runState).map((e) => e.currentState).find((s) => typeof s === "string");
  if (typeof runState === "string") {
    summary.status = { label: humanizeEnum(runState), tone: toneFor(runState) };
  } else {
    for (const op of entries(state.operation)) {
      const mode = Object.entries(op).find(([k, v]) => /OperationMode$/.test(k) && (v === "POWER_ON" || v === "POWER_OFF"));
      if (mode) summary.status = { label: humanizeEnum(mode[1] as string), tone: mode[1] === "POWER_ON" ? "active" : "off" };
    }
  }
  const tone = summary.status?.tone;

  // Temperatures, per compartment when there are several.
  const temps = entries(state.temperature);
  for (const t of temps) {
    const where = typeof t.locationName === "string" ? locationLabel(t.locationName) : undefined;
    if (typeof t.currentTemperature === "number") {
      summary.highlights.push({ label: where ?? "Now", value: formatWithUnit(t.currentTemperature, t.unit, "temperature") });
    }
    if (typeof t.targetTemperature === "number") {
      summary.highlights.push({
        label: where ?? "Target",
        value: formatWithUnit(t.targetTemperature, t.unit, "temperature"),
        ...(where && typeof t.currentTemperature === "number" ? { hint: "target" } : {}),
      });
    }
  }

  // Running programme: time left, end time and progress.
  const timer = entries(state.timer)[0];
  if (timer && (tone === "active" || tone === "paused")) {
    const remaining = minutes(timer, "remain");
    const total = minutes(timer, "total");
    if (remaining !== undefined) {
      const end = new Date(now.getTime() + remaining * 60_000);
      summary.highlights.push({
        label: "Time left",
        value: formatDuration(remaining),
        ...(tone === "active" ? { hint: `ends ~${formatClock(end)}` } : {}),
      });
      if (total !== undefined && total > 0) {
        summary.progress = { remaining: Math.min(remaining, total), total };
      }
    }
  }

  // Selected programme / course / job mode.
  for (const [, resource] of Object.entries(state)) {
    for (const e of entries(resource)) {
      for (const [key, value] of Object.entries(e)) {
        if (/^current\w*(Course|JobMode)$/.test(key) && typeof value === "string") {
          summary.highlights.push({ label: /JobMode$/.test(key) ? "Mode" : "Programme", value: humanizeEnum(value) });
        }
      }
    }
  }

  // Attention needed.
  for (const door of entries(state.doorStatus)) {
    if (door.doorState === "OPEN") {
      const where = typeof door.locationName === "string" && door.locationName !== "MAIN" ? ` (${locationLabel(door.locationName)})` : "";
      summary.alerts.push(`Door open${where}`);
    }
  }
  if (tone === "error") summary.alerts.push("The appliance reports an error");
  for (const s of entries(state.dishWashingStatus)) if (s.rinseRefill === true) summary.alerts.push("Rinse aid needs a refill");
  for (const r of entries(state.refrigeration)) if (r.freshAirFilter === "REPLACE") summary.alerts.push("Replace the fresh air filter");

  // Switched-on modes.
  for (const [, resource] of Object.entries(state)) {
    for (const e of entries(resource)) {
      for (const [key, value] of Object.entries(e)) {
        if (value === true && FEATURE_FLAG.test(key)) summary.features.push(humanizeKey(key));
      }
    }
  }

  return summary;
}
