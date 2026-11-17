/**
 * Persistence for device events and subscriptions. Functions that store an
 * event also publish it on the app's EventBus (see bus.ts), once it is
 * committed, for live listeners such as the event streams.
 */
import { and, asc, count, desc, eq, gt, lt, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { DeviceEvent, EventKind, Subscription } from "../../shared/api.js";
import type { EventBus } from "./bus.js";
import { diffState, type Json } from "./diff.js";

export type { EventKind };
export const EVENT_KINDS: readonly EventKind[] = ["event", "control"];

/** An event as stored (the API sends it as JSON: see DeviceEvent). */
export type StoredEvent = DeviceEvent<Date>;

// ---------------------------------------------------------------------------
// Events

/** Store an event and notify the live listeners on `bus`. */
export function recordEvent(
  bus: EventBus,
  input: { deviceId: string; kind: EventKind; payload: Record<string, unknown>; createdAt?: Date },
): StoredEvent {
  const event = db
    .insert(schema.events)
    .values({ deviceId: input.deviceId, kind: input.kind, payload: input.payload, createdAt: input.createdAt ?? new Date() })
    .returning()
    .get();
  bus.publish(event);
  return event;
}

export interface EventQuery {
  deviceId?: string;
  kind?: EventKind;
  /** Only events with a smaller id (paging backwards). */
  beforeId?: number;
  /** Only events with a larger id (catching up), returned oldest first. */
  afterId?: number;
  /** Skip this many matching events first (jumping to a page). */
  offset?: number;
  limit: number;
}

function eventConditions(q: Pick<EventQuery, "deviceId" | "kind" | "beforeId" | "afterId">): SQL | undefined {
  const where: SQL[] = [];
  if (q.deviceId !== undefined) where.push(eq(schema.events.deviceId, q.deviceId));
  if (q.kind !== undefined) where.push(eq(schema.events.kind, q.kind));
  if (q.beforeId !== undefined) where.push(lt(schema.events.id, q.beforeId));
  if (q.afterId !== undefined) where.push(gt(schema.events.id, q.afterId));
  return and(...where);
}

/** Events newest first, or oldest first when `afterId` is given. */
export function queryEvents(q: EventQuery): StoredEvent[] {
  return db
    .select()
    .from(schema.events)
    .where(eventConditions(q))
    .orderBy(q.afterId !== undefined ? asc(schema.events.id) : desc(schema.events.id))
    .limit(q.limit)
    .offset(q.offset ?? 0)
    .all();
}

/** How many events match (same filters as queryEvents, without paging). */
export function countEvents(q: Pick<EventQuery, "deviceId" | "kind" | "beforeId">): number {
  return db.select({ total: count() }).from(schema.events).where(eventConditions(q)).get()?.total ?? 0;
}

/** Delete state-change events older than `before`. Control records are an audit trail and are kept. */
export function pruneEvents(before: Date): number {
  return db
    .delete(schema.events)
    .where(and(eq(schema.events.kind, "event"), lt(schema.events.createdAt, before)))
    .run().changes;
}

// ---------------------------------------------------------------------------
// Subscriptions

export type SubscriptionInfo = Subscription<Date>;

const MAX_ERROR_LENGTH = 500;

function subscriptionQuery() {
  const s = schema.subscriptions;
  return db
    .select({
      deviceId: s.deviceId,
      alias: schema.devices.alias,
      type: schema.devices.type,
      createdAt: s.createdAt,
      createdBy: schema.users.username,
      lastPolledAt: s.lastPolledAt,
      lastChangeAt: s.lastChangeAt,
      lastError: s.lastError,
      lastErrorAt: s.lastErrorAt,
    })
    .from(s)
    .innerJoin(schema.devices, eq(schema.devices.id, s.deviceId))
    .leftJoin(schema.users, eq(schema.users.id, s.createdBy));
}

export function listSubscriptions(): SubscriptionInfo[] {
  return subscriptionQuery().orderBy(schema.devices.alias, schema.subscriptions.deviceId).all();
}

export function getSubscription(deviceId: string): SubscriptionInfo | undefined {
  return subscriptionQuery().where(eq(schema.subscriptions.deviceId, deviceId)).get();
}

/** Device ids to poll, in a stable order. */
export function subscribedDeviceIds(): string[] {
  return db
    .select({ deviceId: schema.subscriptions.deviceId })
    .from(schema.subscriptions)
    .orderBy(schema.subscriptions.deviceId)
    .all()
    .map((r) => r.deviceId);
}

/** Subscribe a (known) device. Idempotent: an existing subscription keeps its baseline. */
export function subscribe(deviceId: string, userId: number | null, now = new Date()): { created: boolean } {
  const result = db
    .insert(schema.subscriptions)
    .values({ deviceId, createdBy: userId, createdAt: now })
    .onConflictDoNothing()
    .run();
  return { created: result.changes > 0 };
}

export function unsubscribe(deviceId: string): { deleted: boolean } {
  return { deleted: db.delete(schema.subscriptions).where(eq(schema.subscriptions.deviceId, deviceId)).run().changes > 0 };
}

/**
 * Record a freshly polled state: compare it with the baseline, store an event
 * when something changed, and make the new state the baseline. The first poll
 * after subscribing only sets the baseline. Does nothing when the subscription
 * was removed while the state was being fetched.
 */
export function applySnapshot(bus: EventBus, deviceId: string, state: Json, now = new Date()): StoredEvent | null {
  const event = db.transaction((tx) => {
    const sub = tx
      .select({ lastState: schema.subscriptions.lastState })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.deviceId, deviceId))
      .get();
    if (!sub) return null;

    const diff = sub.lastState ? diffState(sub.lastState, state) : null;
    tx.update(schema.subscriptions)
      .set({
        lastState: state,
        lastPolledAt: now,
        lastError: null,
        lastErrorAt: null,
        ...(diff ? { lastChangeAt: now } : {}),
      })
      .where(eq(schema.subscriptions.deviceId, deviceId))
      .run();
    if (!diff) return null;

    return tx
      .insert(schema.events)
      .values({ deviceId, kind: "event", payload: { source: "poll", ...diff }, createdAt: now })
      .returning()
      .get();
  });
  // Publish only once the transaction has committed.
  if (event) bus.publish(event);
  return event;
}

/** Remember why the last poll of a device failed (shown to users; kept short). */
export function markPollError(deviceId: string, message: string, now = new Date()): void {
  db.update(schema.subscriptions)
    .set({ lastError: message.slice(0, MAX_ERROR_LENGTH), lastErrorAt: now })
    .where(eq(schema.subscriptions.deviceId, deviceId))
    .run();
}
