/**
 * Protocol pieces shared by the fake ThinQ devices and server: error codes,
 * the device-profile format and profile-driven command validation.
 *
 * The profile format mirrors ThinQ Connect: each property declares a `type`
 * ("enum" | "range" | "boolean" | "number"), a `mode` ("r" and/or "w") and the
 * allowed values per mode. Resources tied to a part of the appliance (fridge vs
 * freezer compartment) are arrays of entries with a `locationName`.
 */

export type Json = Record<string, unknown>;

/**
 * Error responses, modelled on the ThinQ Connect error codes. The app only
 * relies on status + code being passed through, so keep them in one place in
 * case they need adjusting to match the live service.
 */
export const ERRORS = {
  BAD_REQUEST: { status: 400, code: "1000" },
  MISSING_PARAMETERS: { status: 400, code: "1101" },
  UNACCEPTABLE_PARAMETERS: { status: 400, code: "1102" },
  INVALID_TOKEN: { status: 401, code: "1103" },
  INVALID_MESSAGE_ID: { status: 400, code: "1104" },
  INVALID_API_KEY: { status: 401, code: "1105" },
  NOT_REGISTERED_DEVICE: { status: 404, code: "1206" },
  NOT_FOUND: { status: 404, code: "1207" },
  NOT_CONNECTED_DEVICE: { status: 400, code: "1222" },
  COMMAND_NOT_SUPPORTED_IN_REMOTE_OFF: { status: 400, code: "2301" },
  COMMAND_NOT_SUPPORTED_IN_STATE: { status: 400, code: "2302" },
} as const;

export type ErrorKind = keyof typeof ERRORS;

export class FakeThinQError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
    this.status = ERRORS[kind].status;
    this.code = ERRORS[kind].code;
  }
}

type Mode = "r" | "w";
interface Range {
  min: number;
  max: number;
  step: number;
}

export type PropSpec =
  | { type: "enum"; mode: Mode[]; value: { r?: string[]; w?: string[] } }
  | { type: "boolean"; mode: Mode[]; value: { r?: boolean[]; w?: boolean[] } }
  | { type: "range"; mode: Mode[]; value: { r?: Range; w?: Range } }
  | { type: "number"; mode: Mode[] };

/** A plain resource: property name -> spec. */
export type ResourceSpec = Record<string, PropSpec>;
/** A location-based resource entry, e.g. `{ locationName: "FRIDGE", targetTemperature: {...} }`. */
export type LocatedSpec = { locationName: string } & Record<string, PropSpec | string>;

export interface DeviceProfile {
  property: Record<string, ResourceSpec | LocatedSpec[]>;
  notification?: { push: string[] };
}

/** One validated property write from a control command. */
export interface Change {
  resource: string;
  locationName?: string;
  prop: string;
  value: unknown;
}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check a control command against the device profile and current state and
 * return the property writes it asks for. Read-only properties may be echoed
 * back with their current value (e.g. `unit: "C"` next to a temperature), but
 * cannot be changed.
 */
export function validateCommand(profile: DeviceProfile, state: Json, command: unknown): Change[] {
  if (!isObject(command) || Object.keys(command).length === 0) {
    throw new FakeThinQError("MISSING_PARAMETERS", "Control command must be a non-empty JSON object");
  }

  const changes: Change[] = [];
  for (const [resource, body] of Object.entries(command)) {
    const spec = profile.property[resource];
    if (!spec) throw new FakeThinQError("UNACCEPTABLE_PARAMETERS", `Unknown resource "${resource}"`);
    if (!isObject(body)) throw new FakeThinQError("UNACCEPTABLE_PARAMETERS", `"${resource}" must be an object`);

    let props: Record<string, PropSpec>;
    let current: Json;
    let locationName: string | undefined;
    if (Array.isArray(spec)) {
      locationName = typeof body.locationName === "string" ? body.locationName : undefined;
      if (!locationName) throw new FakeThinQError("MISSING_PARAMETERS", `"${resource}" requires a locationName`);
      const entry = spec.find((e) => e.locationName === locationName);
      if (!entry) {
        throw new FakeThinQError("UNACCEPTABLE_PARAMETERS", `Unknown locationName "${locationName}" for "${resource}"`);
      }
      const { locationName: _, ...rest } = entry;
      props = rest as Record<string, PropSpec>;
      const states = Array.isArray(state[resource]) ? (state[resource] as Json[]) : [];
      current = states.find((s) => s.locationName === locationName) ?? {};
    } else {
      props = spec;
      current = isObject(state[resource]) ? state[resource] : {};
    }

    let writes = 0;
    for (const [prop, value] of Object.entries(body)) {
      if (prop === "locationName" && locationName) continue;
      const propSpec = props[prop];
      if (!propSpec) throw new FakeThinQError("UNACCEPTABLE_PARAMETERS", `Unknown property "${resource}.${prop}"`);
      if (!propSpec.mode.includes("w")) {
        if (current[prop] === value) continue; // echoing a read-only value is fine
        throw new FakeThinQError("UNACCEPTABLE_PARAMETERS", `"${resource}.${prop}" is read-only`);
      }
      checkValue(`${resource}.${prop}`, propSpec, value);
      changes.push({ resource, locationName, prop, value });
      writes++;
    }
    if (writes === 0) {
      throw new FakeThinQError("MISSING_PARAMETERS", `No writable property given for "${resource}"`);
    }
  }
  return changes;
}

function checkValue(name: string, spec: PropSpec, value: unknown): void {
  const reject = (why: string) => {
    throw new FakeThinQError("UNACCEPTABLE_PARAMETERS", `Invalid value ${JSON.stringify(value)} for "${name}": ${why}`);
  };
  switch (spec.type) {
    case "enum": {
      const allowed = spec.value.w ?? spec.value.r ?? [];
      if (typeof value !== "string" || !allowed.includes(value)) reject(`expected one of ${allowed.join(", ")}`);
      break;
    }
    case "boolean": {
      const allowed = spec.value.w ?? [true, false];
      if (typeof value !== "boolean" || !allowed.includes(value)) reject("expected a boolean");
      break;
    }
    case "range": {
      const range = spec.value.w ?? spec.value.r;
      if (typeof value !== "number" || !Number.isFinite(value)) return reject("expected a number");
      if (!range) break;
      if (value < range.min || value > range.max) reject(`expected ${range.min}..${range.max}`);
      const steps = (value - range.min) / range.step;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) reject(`expected a multiple of ${range.step}`);
      break;
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) reject("expected a number");
      break;
  }
}

/** Write validated changes into a ThinQ-shaped state object. */
export function applyChanges(state: Json, changes: Change[]): void {
  for (const { resource, locationName, prop, value } of changes) {
    if (locationName) {
      const entries = (state[resource] ??= []) as Json[];
      let entry = entries.find((e) => e.locationName === locationName);
      if (!entry) entries.push((entry = { locationName }));
      entry[prop] = value;
    } else {
      const target = (isObject(state[resource]) ? state[resource] : (state[resource] = {})) as Json;
      target[prop] = value;
    }
  }
}

/**
 * Deep-merge a patch into state (used by the `/__fake` scenario endpoints).
 * Arrays of location entries merge by `locationName`; other values replace.
 */
export function mergeState(target: Json, patch: Json): void {
  for (const [key, value] of Object.entries(patch)) {
    const existing = target[key];
    if (isObject(value) && isObject(existing)) {
      mergeState(existing, value);
    } else if (Array.isArray(value) && Array.isArray(existing) && value.every((v) => isObject(v) && "locationName" in v)) {
      for (const item of value as Json[]) {
        const match = (existing as Json[]).find((e) => isObject(e) && e.locationName === item.locationName);
        if (match) mergeState(match, item);
        else existing.push(structuredClone(item));
      }
    } else {
      target[key] = structuredClone(value);
    }
  }
}
