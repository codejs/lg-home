/**
 * Helpers for JSON that comes from outside (ThinQ device data, the API),
 * shared by the server and the browser. Reads ignore inherited properties and
 * writes never invoke the `__proto__` setter, so keys such as "__proto__",
 * "constructor" or "toString" are treated as plain data.
 */

export type Json = Record<string, unknown>;

/** A plain JSON object (not null, not an array). */
export function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `obj[key]`, ignoring inherited properties like `constructor`. */
export function own<T>(obj: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** `obj[key] = value`, without ever invoking the `__proto__` setter. */
export function setOwn(obj: Json, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}
