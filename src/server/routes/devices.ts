import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { thinq } from "../thinq/index.js";

export async function deviceRoutes(app: FastifyInstance) {
  /** List devices from the local database (fast, works offline). */
  app.get("/api/devices", async () => {
    return db.select().from(schema.devices).orderBy(schema.devices.alias).all();
  });

  /** Fetch the device list from ThinQ and upsert it into the database. */
  app.post("/api/devices/sync", async () => {
    const list = await thinq().getDevices();
    const now = new Date();
    db.transaction((tx) => {
      for (const d of list) {
        const row = {
          id: d.deviceId,
          type: d.deviceInfo.deviceType,
          alias: d.deviceInfo.alias ?? d.deviceInfo.modelName ?? d.deviceId,
          modelName: d.deviceInfo.modelName ?? null,
          reportable: d.deviceInfo.reportable ?? null,
          raw: d as unknown as Record<string, unknown>,
          updatedAt: now,
        };
        tx.insert(schema.devices)
          .values(row)
          .onConflictDoUpdate({ target: schema.devices.id, set: row })
          .run();
      }
    });
    return db.select().from(schema.devices).orderBy(schema.devices.alias).all();
  });

  /** Fetch live status from ThinQ and record a snapshot. */
  app.get<{ Params: { id: string } }>("/api/devices/:id/status", async (req, reply) => {
    const device = db.select().from(schema.devices).where(eq(schema.devices.id, req.params.id)).get();
    if (!device) return reply.code(404).send({ error: "Unknown device; run a sync first" });

    const state = await thinq().getDeviceStatus(device.id);
    db.insert(schema.deviceStates).values({ deviceId: device.id, state, recordedAt: new Date() }).run();
    return state;
  });

  /** Recent status snapshots for a device. */
  app.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
    "/api/devices/:id/history",
    { schema: { querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 1000 } } } } },
    async (req) => {
      return db
        .select()
        .from(schema.deviceStates)
        .where(eq(schema.deviceStates.deviceId, req.params.id))
        .orderBy(desc(schema.deviceStates.recordedAt), desc(schema.deviceStates.id))
        .limit(req.query.limit ?? 50)
        .all();
    },
  );

  /** The device profile: which resources/properties exist and which are writable. */
  app.get<{ Params: { id: string } }>("/api/devices/:id/profile", async (req) => {
    return thinq().getDeviceProfile(req.params.id);
  });

  /**
   * Send a control command, e.g. `{ "operation": { "airConOperationMode": "POWER_ON" } }`.
   * See the device profile for valid resources and values.
   */
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/devices/:id/control",
    { schema: { body: { type: "object", minProperties: 1 } } },
    async (req) => {
      const result = await thinq().controlDevice(req.params.id, req.body);
      db.insert(schema.events)
        .values({ deviceId: req.params.id, kind: "control", payload: req.body, createdAt: new Date() })
        .run();
      return Object.keys(result).length ? result : { ok: true };
    },
  );
}
