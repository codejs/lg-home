/**
 * Query keys and the queries shared by several components.
 *
 * Components that read or write the same server data must use the same key:
 * e.g. a live state-change event patches a device's status under
 * `queryKeys.status(id)` (events/cache.ts), which is the query the device card
 * reads. Keep every key here so such links stay visible.
 */
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const queryKeys = {
  /** The signed-in user (null when signed out). */
  me: ["me"] as const,
  devices: ["devices"] as const,
  /** A device's live state from ThinQ. */
  status: (deviceId: string) => ["status", deviceId] as const,
  /** Subscribed devices and the poller status. */
  subscriptions: ["subscriptions"] as const,
  /** Prefix of every event query (history, pages, counts; see events/cache.ts). */
  events: ["events"] as const,
};

/** How often a device's live status is refreshed (every refresh is also stored as history). */
export const STATUS_REFRESH_MS = 60_000;

/** The signed-in user; `/api/auth/me` decides between the login page and the app. */
export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: api.me, retry: false, staleTime: 60_000 });
}

/** Devices from the local database. */
export function useDevices() {
  return useQuery({ queryKey: queryKeys.devices, queryFn: api.devices });
}

/** A device's live state, refreshed every STATUS_REFRESH_MS and kept current by live events. */
export function useDeviceStatus(deviceId: string) {
  return useQuery({
    queryKey: queryKeys.status(deviceId),
    queryFn: () => api.status(deviceId),
    refetchInterval: STATUS_REFRESH_MS,
  });
}

/**
 * Forget the session and everything loaded with it, so the app falls back to
 * the login page and the next user sees none of it.
 */
export function signOutLocally(queryClient: QueryClient): void {
  queryClient.setQueryData(queryKeys.me, null);
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.me[0] });
}
