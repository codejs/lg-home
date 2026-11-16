/**
 * Live event streams (Server-Sent Events) to signed-in browsers.
 *
 * A stream is tied to the session that opened it. The session is checked
 * again before every event and on every heartbeat, so signing out, a password
 * change (which drops the user's sessions) or session expiry ends the stream
 * and no further events are delivered on it. Logout closes the session's
 * streams immediately.
 *
 * Resource limits: a few streams per user and a global cap, a bounded replay
 * of missed events, and slow readers are disconnected rather than buffered.
 */
import type { ServerResponse } from "node:http";
import { getSessionUser, type SessionUser } from "../auth.js";
import { onEvent, queryEvents, type EventKind, type StoredEvent } from "./store.js";

export const MAX_STREAMS_PER_USER = 5;
export const MAX_STREAMS_TOTAL = 100;
/** At most this many missed events are replayed on reconnect. */
export const MAX_REPLAY = 500;
export const HEARTBEAT_MS = 25_000;
/** Disconnect a client that lets this much unsent data pile up. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
/** Browsers wait this long before reconnecting. */
const RETRY_MS = 5_000;

interface OpenStream {
  userId: number;
  sessionToken: string;
  close(): void;
}

const open = new Set<OpenStream>();

export type StreamRefusal = "user-limit" | "global-limit";

/** Whether another stream may be opened for this user, or why not. */
export function canOpenStream(userId: number): StreamRefusal | null {
  if (open.size >= MAX_STREAMS_TOTAL) return "global-limit";
  let mine = 0;
  for (const s of open) if (s.userId === userId) mine++;
  return mine >= MAX_STREAMS_PER_USER ? "user-limit" : null;
}

export interface StreamOptions {
  user: SessionUser;
  sessionToken: string;
  deviceId?: string;
  kind?: EventKind;
  /** Replay events after this id first (from the Last-Event-ID header). */
  lastEventId?: number;
  /** Heartbeat (and session re-check) interval; defaults to HEARTBEAT_MS. */
  heartbeatMs?: number;
}

/** Serve an event stream on a raw response that Fastify has handed over. */
export function serveStream(res: ServerResponse, options: StreamOptions): void {
  const { user, sessionToken, deviceId, kind } = options;
  let closed = false;
  let lastSentId = options.lastEventId ?? 0;

  const sessionValid = () => getSessionUser(sessionToken)?.id === user.id;

  const write = (chunk: string) => {
    if (closed) return;
    res.write(chunk);
    if (res.writableLength > MAX_BUFFERED_BYTES) stream.close();
  };

  const send = (event: StoredEvent) => {
    if (closed || event.id <= lastSentId) return;
    if (deviceId !== undefined && event.deviceId !== deviceId) return;
    if (kind !== undefined && event.kind !== kind) return;
    if (!sessionValid()) {
      stream.close();
      return;
    }
    lastSentId = event.id;
    // JSON.stringify escapes newlines, so the data can't break the SSE framing.
    write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const stream: OpenStream = {
    userId: user.id,
    sessionToken,
    close() {
      if (closed) return;
      closed = true;
      open.delete(stream);
      unsubscribe();
      clearInterval(heartbeat);
      res.end();
    },
  };
  open.add(stream);

  const unsubscribe = onEvent(send);
  const heartbeat = setInterval(() => {
    if (!sessionValid()) stream.close();
    else write(": ping\n\n");
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();
  res.on("close", () => stream.close());

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store, no-transform",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
    // Ask reverse proxies (nginx) not to buffer the stream.
    "X-Accel-Buffering": "no",
  });
  write(`retry: ${RETRY_MS}\n\n`);

  if (options.lastEventId !== undefined) {
    // Storing and publishing happen synchronously, so no event can slip in
    // between this query and the live subscription above; `send` also skips
    // anything at or below the last id sent.
    const missed = queryEvents({ afterId: options.lastEventId, deviceId, kind, limit: MAX_REPLAY + 1 });
    if (missed.length > MAX_REPLAY) {
      // Too far behind: tell the client to reload history, then carry on live.
      lastSentId = Math.max(lastSentId, missed[missed.length - 1].id);
      write(`event: reset\ndata: ${JSON.stringify({ reason: "too many missed events; reload the history" })}\n\n`);
    } else {
      for (const event of missed) send(event);
    }
  }
}

/** End the streams of one session, e.g. on logout. */
export function closeStreamsForSession(sessionToken: string | undefined): void {
  if (!sessionToken) return;
  for (const s of [...open]) if (s.sessionToken === sessionToken) s.close();
}

/** End every stream, e.g. on shutdown. */
export function closeAllStreams(): void {
  for (const s of [...open]) s.close();
}

export function openStreamCount(): number {
  return open.size;
}
