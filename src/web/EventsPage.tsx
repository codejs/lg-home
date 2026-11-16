import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type EventKind } from "./api";
import { EventList } from "./EventList";
import { Pagination } from "./Pagination";
import { PollerNotice } from "./PollerNotice";
import { pageCount, useEventCount, useEventPage, useSubscriptions } from "./events/cache";
import { useStreamStatus, type StreamStatus } from "./events/stream";

const STREAM_LABELS: Record<StreamStatus, string> = {
  connecting: "Connecting…",
  open: "Live",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
};

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * All device events, newest first, a page at a time. Page 1 is live: new
 * events appear on top. Older pages are pinned below the newest event seen
 * when leaving page 1, so they don't shift while you read them; a notice says
 * how many newer events have arrived since.
 */
export function EventsPage({ initialDeviceId = "" }: { initialDeviceId?: string }) {
  const [deviceId, setDeviceId] = useState(initialDeviceId);
  const [kind, setKind] = useState<"" | EventKind>("");
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);
  const [before, setBefore] = useState<number | null>(null);
  const deviceSelect = useId();
  const kindSelect = useId();
  const sizeSelect = useId();
  const listTop = useRef<HTMLDivElement>(null);

  const filter = { deviceId: deviceId || undefined, kind: kind || undefined };
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices });
  const subscriptions = useSubscriptions();
  const current = useEventPage({ ...filter, pageSize, page, before });
  const liveTotal = useEventCount(filter, before !== null);
  const stream = useStreamStatus();

  const aliases = useMemo(() => new Map(devices.data?.map((d) => [d.id, d.alias])), [devices.data]);
  const watched = subscriptions.data?.subscriptions ?? [];
  const events = current.data?.events ?? [];
  const total = current.data?.total ?? 0;
  const totalPages = pageCount(total, pageSize);
  const newer = before !== null && liveTotal.data !== undefined ? Math.max(0, liveTotal.data - total) : 0;

  // Back to the first page whenever what is listed changes.
  const resetTo = (apply: () => void) => {
    apply();
    setPage(1);
    setBefore(null);
  };

  const goTo = (next: number) => {
    if (next === page) return;
    if (next === 1) {
      setBefore(null); // the first page is live again
    } else if (before === null) {
      // Leaving the live first page: pin the history below its newest event.
      const newest = events[0]?.id;
      if (newest === undefined) return;
      setBefore(newest + 1);
    }
    setPage(next);
    const top = listTop.current;
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView?.({ block: "start" });
  };

  // Stay within range if the history shrank (e.g. old events pruned).
  useEffect(() => {
    if (current.data && !current.isPlaceholderData && page > totalPages) goTo(totalPages);
  });

  const first = (page - 1) * pageSize + 1;
  const last = first + events.length - 1;

  return (
    <section className="events-page" aria-labelledby="events-title">
      <div className="section-head">
        <h2 id="events-title">Events</h2>
        <span className={`stream-status stream-${stream}`} role="status">
          <span className="dot" aria-hidden="true" />
          {STREAM_LABELS[stream]}
        </span>
      </div>

      <div className="toolbar">
        <div className="field">
          <label htmlFor={deviceSelect}>Device</label>
          <select id={deviceSelect} value={deviceId} onChange={(e) => resetTo(() => setDeviceId(e.target.value))}>
            <option value="">All devices</option>
            {devices.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.alias}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={kindSelect}>Type</label>
          <select id={kindSelect} value={kind} onChange={(e) => resetTo(() => setKind(e.target.value as "" | EventKind))}>
            <option value="">All types</option>
            <option value="event">State changes</option>
            <option value="control">Commands</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={sizeSelect}>Per page</label>
          <select id={sizeSelect} value={pageSize} onChange={(e) => resetTo(() => setPageSize(Number(e.target.value)))}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      <PollerNotice poller={subscriptions.data?.poller} />
      {subscriptions.data && (
        <p className="muted">
          {watched.length === 0
            ? "No devices are watched. Open a device and choose “Watch state changes” to record its changes."
            : `Watching ${watched.map((s) => s.alias).join(", ")}.`}
        </p>
      )}
      {watched
        .filter((s) => s.lastError)
        .map((s) => (
          <p key={s.deviceId} className="error">
            {s.alias}: last check failed: {s.lastError}
          </p>
        ))}

      <div ref={listTop} />
      {newer > 0 && (
        <p className="newer-notice" role="status">
          <span>
            {newer === 1 ? "1 newer event" : `${newer} newer events`} since you left the first page.
          </span>
          <button type="button" onClick={() => goTo(1)}>
            Show newest
          </button>
        </p>
      )}
      {current.error && <p className="error">{current.error.message}</p>}
      {current.isPending ? (
        <p className="muted">Loading events…</p>
      ) : (
        <>
          {total > 0 && events.length > 0 && (
            <p className="muted page-summary" aria-live="polite">
              Showing {first}–{last} of {total} {total === 1 ? "event" : "events"}
              {totalPages > 1 ? ` · page ${page} of ${totalPages}` : ""}
            </p>
          )}
          <div className={current.isPlaceholderData ? "page-loading" : undefined} aria-busy={current.isPlaceholderData}>
            <EventList events={events} aliases={aliases} emptyText="No events match." />
          </div>
          <Pagination page={page} totalPages={totalPages} onPage={goTo} disabled={current.isFetching} label="Event pages" />
        </>
      )}
    </section>
  );
}
