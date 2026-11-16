import type { ThinQDeviceApi } from "../../src/server/routes/devices.js";
import type { JsonObject, ThinQDevice } from "../../src/server/thinq/client.js";

type Call = { method: keyof ThinQDeviceApi; args: unknown[] };

/**
 * In-memory ThinQ stand-in for route unit tests: canned responses per method,
 * an optional error to throw, and a log of every call.
 */
export class StubThinQ implements ThinQDeviceApi {
  devices: unknown = [];
  status: JsonObject = { ok: true };
  profile: JsonObject = { property: {} };
  controlResult: JsonObject = {};
  /** When set, every call rejects with this. */
  error: unknown = null;
  readonly calls: Call[] = [];

  private async call<T>(method: keyof ThinQDeviceApi, args: unknown[], value: T): Promise<T> {
    this.calls.push({ method, args });
    if (this.error) throw this.error;
    return structuredClone(value);
  }

  getDevices(): Promise<ThinQDevice[]> {
    return this.call("getDevices", [], this.devices as ThinQDevice[]);
  }
  getDeviceStatus(id: string): Promise<JsonObject> {
    return this.call("getDeviceStatus", [id], this.status);
  }
  getDeviceProfile(id: string): Promise<JsonObject> {
    return this.call("getDeviceProfile", [id], this.profile);
  }
  controlDevice(id: string, command: JsonObject): Promise<JsonObject> {
    return this.call("controlDevice", [id, command], this.controlResult);
  }
}
