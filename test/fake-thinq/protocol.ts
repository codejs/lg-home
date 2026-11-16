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
 * ThinQ Connect error codes, copied verbatim from LG's official SDK
 * (`thinqconnect` 1.0.14, `ThinQAPIErrorCodes`). This is the reference the
 * fake's own errors are checked against - do not add codes LG doesn't define.
 */
export const THINQ_ERROR_CODES = {
  UNKNOWN_ERROR: "0000",
  BAD_REQUEST: "1000",
  MISSING_PARAMETERS: "1101",
  UNACCEPTABLE_PARAMETERS: "1102",
  INVALID_TOKEN: "1103",
  INVALID_MESSAGE_ID: "1104",
  NOT_REGISTERED_ADMIN: "1201",
  NOT_REGISTERED_USER: "1202",
  NOT_REGISTERED_SERVICE: "1203",
  NOT_SUBSCRIBED_EVENT: "1204",
  NOT_EXIST_DEVICE: "1205",
  NOT_SUBSCRIBED_PUSH: "1206",
  ALREADY_SUBSCRIBED_PUSH: "1207",
  NOT_REGISTERED_SERVICE_BY_ADMIN: "1208",
  NOT_REGISTERED_USER_IN_SERVICE: "1209",
  NOT_REGISTERED_DEVICE_IN_SERVICE: "1210",
  NOT_REGISTERED_DEVICE_BY_USER: "1211",
  NOT_OWNED_DEVICE: "1212",
  NOT_REGISTERED_DEVICE: "1213",
  NOT_SUBSCRIBABLE_DEVICE: "1214",
  INCORRECT_HEADER: "1216",
  ALREADY_DEVICE_DELETED: "1217",
  INVALID_TOKEN_AGAIN: "1218",
  NOT_SUPPORTED_MODEL: "1219",
  NOT_SUPPORTED_FEATURE: "1220",
  NOT_SUPPORTED_PRODUCT: "1221",
  NOT_CONNECTED_DEVICE: "1222",
  INVALID_STATUS_DEVICE: "1223",
  INVALID_DEVICE_ID: "1224",
  DUPLICATE_DEVICE_ID: "1225",
  INVALID_SERVICE_KEY: "1301",
  NOT_FOUND_TOKEN: "1302",
  NOT_FOUND_USER: "1303",
  NOT_ACCEPTABLE_TERMS: "1304",
  NOT_ALLOWED_API: "1305",
  EXCEEDED_API_CALLS: "1306",
  NOT_SUPPORTED_COUNTRY: "1307",
  NO_CONTROL_AUTHORITY: "1308",
  NOT_ALLOWED_API_AGAIN: "1309",
  NOT_SUPPORTED_DOMAIN: "1310",
  BAD_REQUEST_FORMAT: "1311",
  EXCEEDED_NUMBER_OF_EVENT_SUBSCRIPTION: "1312",
  INTERNAL_SERVER_ERROR: "2000",
  NOT_SUPPORTED_MODEL_AGAIN: "2101",
  NOT_PROVIDED_FEATURE: "2201",
  NOT_SUPPORTED_PRODUCT_AGAIN: "2202",
  NOT_EXISTENT_MODEL_JSON: "2203",
  INVALID_DEVICE_STATUS: "2205",
  INVALID_COMMAND_ERROR: "2207",
  FAIL_DEVICE_CONTROL: "2208",
  DEVICE_RESPONSE_DELAY: "2209",
  RETRY_REQUEST: "2210",
  SYNCING: "2212",
  RETRY_AFTER_DELETING_DEVICE: "2213",
  FAIL_REQUEST: "2214",
  COMMAND_NOT_SUPPORTED_IN_REMOTE_OFF: "2301",
  COMMAND_NOT_SUPPORTED_IN_STATE: "2302",
  COMMAND_NOT_SUPPORTED_IN_ERROR: "2303",
  COMMAND_NOT_SUPPORTED_IN_POWER_OFF: "2304",
  COMMAND_NOT_SUPPORTED_IN_MODE: "2305",
} as const;

export type ThinQErrorName = keyof typeof THINQ_ERROR_CODES;

/**
 * The errors the fake produces: an official code plus the HTTP status the fake
 * answers with. Keys must be official names, so the codes can't drift from
 * LG's list. The statuses are our best model of the live service (the SDK only
 * documents codes).
 */
export const ERRORS = {
  BAD_REQUEST: { status: 400, code: THINQ_ERROR_CODES.BAD_REQUEST },
  MISSING_PARAMETERS: { status: 400, code: THINQ_ERROR_CODES.MISSING_PARAMETERS },
  UNACCEPTABLE_PARAMETERS: { status: 400, code: THINQ_ERROR_CODES.UNACCEPTABLE_PARAMETERS },
  INVALID_TOKEN: { status: 401, code: THINQ_ERROR_CODES.INVALID_TOKEN },
  INVALID_MESSAGE_ID: { status: 400, code: THINQ_ERROR_CODES.INVALID_MESSAGE_ID },
  // A header with a wrong value, e.g. an x-api-key that isn't LG's.
  INCORRECT_HEADER: { status: 400, code: THINQ_ERROR_CODES.INCORRECT_HEADER },
  NOT_EXIST_DEVICE: { status: 404, code: THINQ_ERROR_CODES.NOT_EXIST_DEVICE },
  NOT_CONNECTED_DEVICE: { status: 400, code: THINQ_ERROR_CODES.NOT_CONNECTED_DEVICE },
  EXCEEDED_API_CALLS: { status: 429, code: THINQ_ERROR_CODES.EXCEEDED_API_CALLS },
  INTERNAL_SERVER_ERROR: { status: 500, code: THINQ_ERROR_CODES.INTERNAL_SERVER_ERROR },
  COMMAND_NOT_SUPPORTED_IN_REMOTE_OFF: { status: 400, code: THINQ_ERROR_CODES.COMMAND_NOT_SUPPORTED_IN_REMOTE_OFF },
  COMMAND_NOT_SUPPORTED_IN_STATE: { status: 400, code: THINQ_ERROR_CODES.COMMAND_NOT_SUPPORTED_IN_STATE },
  COMMAND_NOT_SUPPORTED_IN_POWER_OFF: { status: 400, code: THINQ_ERROR_CODES.COMMAND_NOT_SUPPORTED_IN_POWER_OFF },
} as const satisfies Partial<Record<ThinQErrorName, { status: number; code: string }>>;

export type ErrorKind = keyof typeof ERRORS;

export class FakeThinQError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(
    readonly kind: ErrorKind,
    message: string,
    /** Override the HTTP status, e.g. 404 for an unknown endpoint (which has no code of its own). */
    status?: number,
  ) {
    super(message);
    this.status = status ?? ERRORS[kind].status;
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
