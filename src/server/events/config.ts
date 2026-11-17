/**
 * Settings for device events, read from the environment.
 *
 *   EVENT_POLL_INTERVAL_SECONDS  how often subscribed devices are polled (default 60)
 *   EVENT_RETENTION_DAYS         how long state-change events are kept (default 30)
 *
 * Every poll is one ThinQ API call per subscribed device, and ThinQ limits API
 * calls per account (error 1306), so intervals below 15 s are refused - except
 * when THINQ_API_BASE_URL points at this machine (the fake ThinQ API), where
 * tests and local development need fast polling. Invalid values stop the
 * server from starting rather than being silently replaced.
 */

export interface EventConfig {
  pollIntervalMs: number;
  retentionDays: number;
}

export const DEFAULT_POLL_INTERVAL_SECONDS = 60;
/** Floor for the real ThinQ API. */
export const MIN_POLL_INTERVAL_SECONDS = 15;
/** Floor when ThinQ is a local fake. */
export const MIN_LOCAL_POLL_INTERVAL_SECONDS = 0.05;
export const MAX_POLL_INTERVAL_SECONDS = 24 * 60 * 60;
export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

export class EventConfigError extends Error {
  override name = "EventConfigError";
}

export function eventConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EventConfig {
  const local = isLoopbackUrl(env.THINQ_API_BASE_URL);
  const minInterval = local ? MIN_LOCAL_POLL_INTERVAL_SECONDS : MIN_POLL_INTERVAL_SECONDS;

  const interval = parseNumber(env.EVENT_POLL_INTERVAL_SECONDS, "EVENT_POLL_INTERVAL_SECONDS") ?? DEFAULT_POLL_INTERVAL_SECONDS;
  if (interval < minInterval || interval > MAX_POLL_INTERVAL_SECONDS) {
    throw new EventConfigError(
      `EVENT_POLL_INTERVAL_SECONDS must be between ${minInterval} and ${MAX_POLL_INTERVAL_SECONDS} (got ${interval})` +
        (local ? "" : `; intervals below ${MIN_POLL_INTERVAL_SECONDS} s are only allowed against a local fake ThinQ API`),
    );
  }

  const retention = parseNumber(env.EVENT_RETENTION_DAYS, "EVENT_RETENTION_DAYS") ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(retention) || retention < 1 || retention > MAX_RETENTION_DAYS) {
    throw new EventConfigError(`EVENT_RETENTION_DAYS must be a whole number from 1 to ${MAX_RETENTION_DAYS} (got ${retention})`);
  }

  return { pollIntervalMs: Math.round(interval * 1000), retentionDays: retention };
}

function parseNumber(raw: string | undefined, name: string): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  // Plain decimal notation only: no hex, exponents, Infinity or trailing junk.
  if (!/^\d+(\.\d+)?$/.test(value)) throw new EventConfigError(`${name} must be a positive number (got "${raw}")`);
  return Number(value);
}

/** True for http(s) URLs whose host is this machine (localhost, 127.0.0.0/8, ::1). */
export function isLoopbackUrl(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}
