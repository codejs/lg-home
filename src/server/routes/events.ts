/**
 * Device event routes: subscribe devices to state-change events, read the
 * event history and follow new events live (Server-Sent Events).
 *
 * All of them sit behind the session gate (see auth.ts). Subscriptions are
 * shared: they belong to the one ThinQ account, not to a user.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { sessionTokenOf } from "../auth.js";
import type { EventPoller } from "../events/poller.js";
import {
  EVENT_KINDS,
  countEvents,
  getSubscription,
  listSubscriptions,
  queryEvents,
  subscribe,
  unsubscribe,
  type EventKind,
} from "../events/store.js";
import { canOpenStream, serveStream } from "../events/streams.js";

export interface EventRoutesOptions {
  poller: EventPoller;
}

const DEVICE_ID = { type: "string", minLength: 1, maxLength: 256 } as const;
const deviceParams = {
  type: "object",
  required: ["id"],
  properties: { id: DEVICE_ID },
} as const;

export const MAX_PAGE_SIZE = 200;
/** Deepest page reachable by offset; bounds the cost of a query. */
export const MAX_OFFSET = 100_000;

/** `Last-Event-ID` as sent by EventSource: a plain non-negative integer. */
function parseLastEventId(raw: string | string[] | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

export async function eventRoutes(app: FastifyInstance, { poller }: EventRoutesOptions) {
  const deviceExists = (id: string) =>
    db.select({ id: schema.devices.id }).from(schema.devices).where(eq(schema.devices.id, id)).get() !== undefined;

  /** Subscribed devices, and whether polling is running or paused. */
  app.get("/api/subscriptions", async () => {
    return { poller: poller.status(), subscriptions: listSubscriptions() };
  });

  /** Subscribe a device to state-change events. Idempotent: 201 when new, 200 when already subscribed. */
  app.put<{ Params: { id: string } }>(
    "/api/devices/:id/subscription",
    { schema: { params: deviceParams } },
    async (req, reply) => {
      const { id } = req.params;
      if (!deviceExists(id)) return reply.code(404).send({ error: "Unknown device; run a sync first" });

      const { created } = subscribe(id, req.user?.id ?? null);
      if (created) {
        req.log.info({ userId: req.user?.id, deviceId: id }, "device subscribed to events");
        poller.trigger(); // take the baseline soon
      }
      return reply.code(created ? 201 : 200).send(getSubscription(id));
    },
  );

  /** Stop watching a device. Idempotent. Its past events are kept. */
  app.delete<{ Params: { id: string } }>(
    "/api/devices/:id/subscription",
    { schema: { params: deviceParams } },
    async (req, reply) => {
      const { id } = req.params;
      if (!deviceExists(id)) return reply.code(404).send({ error: "Unknown device" });
      if (unsubscribe(id).deleted) req.log.info({ userId: req.user?.id, deviceId: id }, "device unsubscribed from events");
      return reply.code(204).send();
    },
  );

  /**
   * Event history, newest first. Page backwards with `before` = the smallest
   * id seen, or jump to a page with `offset`. Numbered pages stay stable while
   * new events arrive when `before` pins them below a fixed id.
   */
  app.get<{ Querystring: { deviceId?: string; kind?: EventKind; before?: number; offset?: number; limit?: number } }>(
    "/api/events",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            deviceId: DEVICE_ID,
            kind: { type: "string", enum: EVENT_KINDS },
            before: { type: "integer", minimum: 1 },
            offset: { type: "integer", minimum: 0, maximum: MAX_OFFSET },
            limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const { deviceId, kind, before, offset, limit } = req.query;
      return queryEvents({ deviceId, kind, beforeId: before, offset, limit: limit ?? 50 });
    },
  );

  /** How many events match the same filters as the history (for "page 2 of 9"). */
  app.get<{ Querystring: { deviceId?: string; kind?: EventKind; before?: number } }>(
    "/api/events/count",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            deviceId: DEVICE_ID,
            kind: { type: "string", enum: EVENT_KINDS },
            before: { type: "integer", minimum: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const { deviceId, kind, before } = req.query;
      return { total: countEvents({ deviceId, kind, beforeId: before }) };
    },
  );

  /**
   * Live events as Server-Sent Events (one JSON event per message, `id` = event
   * id). Reconnecting clients send `Last-Event-ID` and get what they missed.
   */
  app.get<{ Querystring: { deviceId?: string; kind?: EventKind } }>(
    "/api/events/stream",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { deviceId: DEVICE_ID, kind: { type: "string", enum: EVENT_KINDS } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const user = req.user;
      const sessionToken = sessionTokenOf(req);
      // The auth gate guarantees both; checked again so a routing mistake fails closed.
      if (!user || !sessionToken) return reply.code(401).send({ error: "Authentication required" });

      const lastEventId = parseLastEventId(req.headers["last-event-id"]);
      if (lastEventId === null) return reply.code(400).send({ error: "Invalid Last-Event-ID header" });

      const refusal = canOpenStream(user.id);
      if (refusal) {
        req.log.warn({ userId: user.id, refusal }, "event stream refused");
        return reply.code(429).send({ error: "Too many open event streams" });
      }

      reply.hijack();
      serveStream(reply.raw, { user, sessionToken, deviceId: req.query.deviceId, kind: req.query.kind, lastEventId });
    },
  );
}
