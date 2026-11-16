/**
 * The live event stream: one EventSource for the signed-in app, feeding new
 * events into the query cache (see cache.ts) and exposing its connection state.
 *
 * The browser reconnects by itself after a dropped connection and sends
 * Last-Event-ID, so the server replays what was missed. When the stream fails
 * for good (the server refused it, e.g. because the session ended), we check
 * the session: signed out -> back to the login page; otherwise reconnect with
 * a growing delay and reload the history, which covers anything missed.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, EVENT_STREAM_URL, notifyUnauthorized } from "../api";
import { applyLiveEvent } from "./cache";
import { parseEvent } from "./format";

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

/** The parts of EventSource the app uses (lets tests supply a fake). */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

const CONNECTING = 0;
export const STREAM_RETRY_DELAYS_MS = [5_000, 10_000, 30_000, 60_000];

const defaultFactory: EventSourceFactory = (url) => new EventSource(url);

const StatusContext = createContext<StreamStatus>("closed");

export function useStreamStatus(): StreamStatus {
  return useContext(StatusContext);
}

export function EventStreamProvider({
  children,
  createEventSource = defaultFactory,
  retryDelaysMs = STREAM_RETRY_DELAYS_MS,
}: {
  children: ReactNode;
  createEventSource?: EventSourceFactory;
  retryDelaysMs?: readonly number[];
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>("connecting");

  useEffect(() => {
    let source: EventSourceLike | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const current = createEventSource(EVENT_STREAM_URL);
      source = current;
      setStatus(failures > 0 ? "reconnecting" : "connecting");

      current.onopen = () => {
        if (disposed) return;
        setStatus("open");
        if (failures > 0) {
          // A fresh EventSource can't resume where the old one stopped.
          void queryClient.invalidateQueries({ queryKey: ["events"] });
          failures = 0;
        }
      };
      current.onmessage = (message) => {
        const event = parseEvent(String(message.data));
        if (event && !disposed) applyLiveEvent(queryClient, event);
      };
      // Sent when we were too far behind to replay: reload the history.
      current.addEventListener("reset", () => void queryClient.invalidateQueries({ queryKey: ["events"] }));
      current.onerror = () => {
        if (disposed || source !== current) return;
        if (current.readyState === CONNECTING) {
          setStatus("reconnecting"); // the browser retries by itself
          return;
        }
        current.close();
        setStatus("closed");
        api.me().then(
          (user) => {
            if (disposed) return;
            if (user) retry();
            else notifyUnauthorized();
          },
          () => retry(),
        );
      };
    };

    const retry = () => {
      if (disposed) return;
      const delay = retryDelaysMs[Math.min(failures, retryDelaysMs.length - 1)];
      failures++;
      retryTimer = setTimeout(connect, delay);
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [queryClient, createEventSource, retryDelaysMs]);

  return <StatusContext.Provider value={status}>{children}</StatusContext.Provider>;
}
