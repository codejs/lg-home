import type { FastifyInstance } from "fastify";
import type { JsonSchemaToTsProvider } from "@fastify/type-provider-json-schema-to-ts";
import { getDevice, listDevices, recordStatus, saveDevices, statusHistory, usableDevices } from "../devices/store.js";
import type { EventBus } from "../events/bus.js";
import { recordEvent } from "../events/store.js";
import { thinq as defaultThinQ, type ThinQClient } from "../thinq/index.js";

/** The part of the ThinQ client these routes use (lets tests pass a stub). */
export type ThinQDeviceApi = Pick<ThinQClient, "getDevices" | "getDeviceStatus" | "getDeviceProfile" | "controlDevice">;

export interface DeviceRoutesOptions {
  thinq?: () => ThinQDeviceApi;
  /** The app's event bus: control commands are recorded as events and published on it. */
  bus: EventBus;
}

/**
 * `:id` as Fastify always provides it. Deliberately no further limits: this
 * only types the parameter, it must not change which requests are accepted.
 */
const deviceParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
} as const;

export async function deviceRoutes(instance: FastifyInstance, options: DeviceRoutesOptions) {
  // Request types are derived from the route schemas below.
  const app = instance.withTypeProvider<JsonSchemaToTsProvider>();
  const thinq = options.thinq ?? defaultThinQ;

  /** List devices from the local database (fast, works offline). */
  app.get("/api/devices", async () => listDevices());

  /** Fetch the device list from ThinQ and upsert it into the database. */
  app.post("/api/devices/sync", async () => {
    const { devices, skipped } = usableDevices(await thinq().getDevices());
    if (skipped > 0) app.log.warn({ skipped }, "ignored malformed devices from ThinQ");
    saveDevices(devices);
    return listDevices();
  });

  /** Fetch live status from ThinQ and record a snapshot. */
  app.get("/api/devices/:id/status", { schema: { params: deviceParams } }, async (req, reply) => {
    const device = getDevice(req.params.id);
    if (!device) return reply.code(404).send({ error: "Unknown device; run a sync first" });

    const state = await thinq().getDeviceStatus(device.id);
    recordStatus(device.id, state);
    return state;
  });

  /** Recent status snapshots for a device. */
  app.get(
    "/api/devices/:id/history",
    {
      schema: {
        params: deviceParams,
        querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 1000 } } },
      },
    },
    async (req) => statusHistory(req.params.id, req.query.limit ?? 50),
  );

  /** The device profile: which resources/properties exist and which are writable. */
  app.get("/api/devices/:id/profile", { schema: { params: deviceParams } }, async (req) => {
    return thinq().getDeviceProfile(req.params.id);
  });

  /**
   * Send a control command, e.g. `{ "operation": { "airConOperationMode": "POWER_ON" } }`.
   * See the device profile for valid resources and values.
   */
  app.post(
    "/api/devices/:id/control",
    { schema: { params: deviceParams, body: { type: "object", minProperties: 1 } } },
    async (req) => {
      const result = await thinq().controlDevice(req.params.id, req.body);
      recordEvent(options.bus, { deviceId: req.params.id, kind: "control", payload: req.body });
      return Object.keys(result).length ? result : { ok: true };
    },
  );
}
