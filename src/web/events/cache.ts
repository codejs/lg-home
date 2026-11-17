/**
 * Query-cache plumbing for device events: the history, page, count and
 * subscription queries, and folding a live event into everything cached.
 *
 * Cache keys (all under queryKeys.events = ["events"], so invalidating that reloads them all):
 *   ["events", "history", { deviceId, kind, pageSize }]     newest first, "load more" style
 *   ["events", "page", { deviceId, kind, pageSize, page, before }]  one numbered page
 *   ["events", "count", { deviceId, kind }]                 all matching events, kept live
 */
import { keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { api, type DeviceEvent, type EventFilter } from "../api";
import { queryKeys } from "../queries";
import { applyReport, matchesFilter } from "./format";

export const EVENTS_PAGE_SIZE = 50;
/** Deepest offset the server accepts (see MAX_OFFSET in the server routes). */
export const MAX_EVENT_OFFSET = 100_000;

type EventPages = InfiniteData<DeviceEvent[], number | undefined>;

export function eventsKey(filter: EventFilter, pageSize: number) {
  return [...queryKeys.events, "history", { deviceId: filter.deviceId, kind: filter.kind, pageSize }] as const;
}

/** Event history for a filter, newest first, loading older pages on demand. */
export function useEventHistory(filter: EventFilter, pageSize = EVENTS_PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: eventsKey(filter, pageSize),
    queryFn: ({ pageParam }) => api.events({ ...filter, before: pageParam, limit: pageSize }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length < pageSize ? undefined : last[last.length - 1].id),
  });
}

// ---------------------------------------------------------------------------
// Numbered pages

export interface EventPageParams extends EventFilter {
  pageSize: number;
  /** 1-based. */
  page: number;
  /**
   * Only events with a smaller id: pins the pages, so they don't shift while
   * new events arrive. null = not pinned (page 1, which stays live).
   */
  before: number | null;
}

export interface EventPage {
  events: DeviceEvent[];
  /** Matching events in the (pinned) history. */
  total: number;
}

export function eventPageKey(p: EventPageParams) {
  return [...queryKeys.events, "page", { deviceId: p.deviceId, kind: p.kind, pageSize: p.pageSize, page: p.page, before: p.before }] as const;
}

export function eventCountKey(filter: EventFilter) {
  return [...queryKeys.events, "count", { deviceId: filter.deviceId, kind: filter.kind }] as const;
}

/** One numbered page of events and the matching total; shows the previous page while the next loads. */
export function useEventPage(p: EventPageParams) {
  return useQuery({
    queryKey: eventPageKey(p),
    queryFn: async (): Promise<EventPage> => {
      const filter = { deviceId: p.deviceId, kind: p.kind, before: p.before ?? undefined };
      const [events, { total }] = await Promise.all([
        api.events({ ...filter, offset: (p.page - 1) * p.pageSize, limit: p.pageSize }),
        api.countEvents(filter),
      ]);
      return { events, total };
    },
    placeholderData: keepPreviousData,
  });
}

/** All matching events, including ones newer than a pinned page. Kept current by live events. */
export function useEventCount(filter: EventFilter, enabled = true) {
  return useQuery({ queryKey: eventCountKey(filter), queryFn: async () => (await api.countEvents(filter)).total, enabled });
}

/** Pages to offer for `total` events, within what the server can reach. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.min(Math.ceil(total / pageSize), Math.floor(MAX_EVENT_OFFSET / pageSize) + 1));
}

/** Page buttons to show: first, last, and the current one with its neighbours; "gap" for the rest. */
export function pageItems(current: number, totalPages: number): (number | "gap")[] {
  const pages = new Set([1, totalPages, current - 1, current, current + 1].filter((n) => n >= 1 && n <= totalPages));
  // Fill a gap of exactly one page instead of showing "…" for it.
  for (const n of [2, totalPages - 1]) if (pages.has(n - 1) && pages.has(n + 1)) pages.add(n);
  const sorted = [...pages].sort((a, b) => a - b);
  const items: (number | "gap")[] = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) items.push("gap");
    items.push(n);
  });
  return items;
}

// ---------------------------------------------------------------------------

/** Subscribed devices and poller status. Cheap (served from the local database), so kept fresh. */
export function useSubscriptions() {
  return useQuery({ queryKey: queryKeys.subscriptions, queryFn: api.subscriptions, refetchInterval: 30_000 });
}

/**
 * Fold a live event into the cache: the event lists and counts it belongs to,
 * the device status, subscriptions. Pinned pages are left as they are.
 */
export function applyLiveEvent(queryClient: QueryClient, event: DeviceEvent): void {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: queryKeys.events })) {
    const [, type, params] = query.queryKey as readonly [string, string, (EventFilter & Partial<EventPageParams>) | undefined];
    if (!params || !matchesFilter(event, params)) continue;
    if (type === "history") {
      queryClient.setQueryData<EventPages>(query.queryKey, (data) => prependEvent(data, event));
    } else if (type === "page" && params.page === 1 && params.before === null) {
      queryClient.setQueryData<EventPage>(query.queryKey, (data) => prependToPage(data, event, params.pageSize ?? EVENTS_PAGE_SIZE));
    } else if (type === "count") {
      queryClient.setQueryData<number>(query.queryKey, (total) => (total === undefined ? total : total + 1));
    }
  }

  const report = event.payload.report;
  if (event.kind === "event" && event.deviceId && typeof report === "object" && report !== null && !Array.isArray(report)) {
    // Keep the status panel current without another ThinQ call.
    queryClient.setQueryData<Record<string, unknown>>(queryKeys.status(event.deviceId), (state) =>
      state ? applyReport(state, report as Record<string, unknown>) : state,
    );
  }
  void queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions });
}

/** Add a newer event on top; events already shown, or older than the newest shown, are left to the history. */
export function prependEvent(data: EventPages | undefined, event: DeviceEvent): EventPages | undefined {
  if (!data || data.pages.length === 0) return data;
  const newest = data.pages[0][0];
  if (newest && event.id <= newest.id) return data;
  return { ...data, pages: [[event, ...data.pages[0]], ...data.pages.slice(1)] };
}

/** The live first page after a new event: on top, the oldest one moves on to page 2. */
export function prependToPage(data: EventPage | undefined, event: DeviceEvent, pageSize: number): EventPage | undefined {
  if (!data) return data;
  const newest = data.events[0];
  if (newest && event.id <= newest.id) return data;
  return { events: [event, ...data.events].slice(0, pageSize), total: data.total + 1 };
}
