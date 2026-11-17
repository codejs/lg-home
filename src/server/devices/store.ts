/**
 * The local copy of the account's devices (synced from ThinQ) and the history
 * of their status snapshots.
 */
import { desc, eq } from "drizzle-orm";
import type { Device } from "../../shared/api.js";
import { db, schema } from "../db/index.js";
import type { ThinQDevice } from "../thinq/client.js";

/** A stored device; the API sends these as they are (see Device). */
export type DeviceRow = Device<Date>;
export type StatusSnapshot = typeof schema.deviceStates.$inferSelect;

/** All devices, by name. */
export function listDevices(): DeviceRow[] {
  return db.select().from(schema.devices).orderBy(schema.devices.alias).all();
}

export function getDevice(id: string): DeviceRow | undefined {
  return db.select().from(schema.devices).where(eq(schema.devices.id, id)).get();
}

export function deviceExists(id: string): boolean {
  return db.select({ id: schema.devices.id }).from(schema.devices).where(eq(schema.devices.id, id)).get() !== undefined;
}

/** ThinQ data is external input: only entries with an id and a type can be stored. */
export function isUsableDevice(d: unknown): d is ThinQDevice {
  const device = d as Partial<ThinQDevice> | null;
  return (
    typeof device?.deviceId === "string" &&
    device.deviceId.length > 0 &&
    typeof device.deviceInfo === "object" &&
    device.deviceInfo !== null &&
    typeof device.deviceInfo.deviceType === "string"
  );
}

/** The storable entries of a ThinQ device list, and how many were not. */
export function usableDevices(fetched: unknown): { devices: ThinQDevice[]; skipped: number } {
  const devices = Array.isArray(fetched) ? fetched.filter(isUsableDevice) : [];
  const skipped = (Array.isArray(fetched) ? fetched.length : 0) - devices.length;
  return { devices, skipped };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Insert or update devices from ThinQ, in one transaction. */
export function saveDevices(devices: readonly ThinQDevice[], now = new Date()): void {
  db.transaction((tx) => {
    for (const d of devices) {
      const info = d.deviceInfo;
      const row = {
        id: d.deviceId,
        type: info.deviceType,
        alias: str(info.alias) ?? str(info.modelName) ?? d.deviceId,
        modelName: str(info.modelName) ?? null,
        reportable: typeof info.reportable === "boolean" ? info.reportable : null,
        raw: d as unknown as Record<string, unknown>,
        updatedAt: now,
      };
      tx.insert(schema.devices)
        .values(row)
        .onConflictDoUpdate({ target: schema.devices.id, set: row })
        .run();
    }
  });
}

/** Store a status snapshot (every live status read is kept as history). */
export function recordStatus(deviceId: string, state: Record<string, unknown>, recordedAt = new Date()): void {
  db.insert(schema.deviceStates).values({ deviceId, state, recordedAt }).run();
}

/** A device's most recent status snapshots, newest first. */
export function statusHistory(deviceId: string, limit: number): StatusSnapshot[] {
  return db
    .select()
    .from(schema.deviceStates)
    .where(eq(schema.deviceStates.deviceId, deviceId))
    .orderBy(desc(schema.deviceStates.recordedAt), desc(schema.deviceStates.id))
    .limit(limit)
    .all();
}
