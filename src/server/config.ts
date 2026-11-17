/**
 * The server's settings, read from the environment once at startup and
 * checked together: `loadConfig` reports every invalid value at once and the
 * server refuses to start, rather than failing later or silently falling back.
 *
 *   PORT, HOST                    where to listen (default 3000 on 127.0.0.1)
 *   LOG_LEVEL                     fatal, error, warn, info (default), debug, trace or silent
 *   DATABASE_PATH                 SQLite file (default data/lg-home.db)
 *   SESSION_TTL_HOURS             how long a login stays valid (default 168 = 7 days)
 *   COOKIE_SECURE                 true/1 or false/0 forces the cookie's Secure flag;
 *                                 unset detects HTTPS per request
 *   EVENT_POLL_INTERVAL_SECONDS,
 *   EVENT_RETENTION_DAYS          device events, see events/config.ts
 *
 * The ThinQ settings (THINQ_*) are not checked here: without them the server
 * still starts and answers device calls with 503 (see thinq/index.ts).
 */
import { DEFAULT_SESSION_TTL_MS } from "./auth/sessions.js";
import { eventConfigFromEnv, type EventConfig } from "./events/config.js";

export interface ServerConfig {
  port: number;
  host: string;
  logLevel: LogLevel;
  databasePath: string;
  sessionTtlMs: number;
  /** null: decide per request (HTTPS or not). */
  cookieSecure: boolean | null;
  events: EventConfig;
}

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_DATABASE_PATH = "data/lg-home.db";
export const MAX_SESSION_TTL_HOURS = 24 * 366;

/** One or more invalid settings; the message lists them all, one per line. */
export class ConfigError extends Error {
  override name = "ConfigError";
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

type Env = NodeJS.ProcessEnv;

/** Read and check every setting; throws ConfigError listing all problems. */
export function loadConfig(env: Env = process.env): ServerConfig {
  const problems: string[] = [];
  const read = <T>(parse: () => T): T | undefined => {
    try {
      return parse();
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  };
  const config = {
    port: read(() => portFromEnv(env)),
    host: read(() => hostFromEnv(env)),
    logLevel: read(() => logLevelFromEnv(env)),
    databasePath: read(() => databasePathFromEnv(env)),
    sessionTtlMs: read(() => sessionTtlMs(env)),
    cookieSecure: read(() => cookieSecureFromEnv(env)),
    events: read(() => eventConfigFromEnv(env)),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config as ServerConfig;
}

const setting = (env: Env, name: string): string | undefined => env[name]?.trim() || undefined;

export function portFromEnv(env: Env = process.env): number {
  const raw = setting(env, "PORT");
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) throw new Error(`PORT must be a whole number from 0 to 65535 (got "${raw}")`);
  return port;
}

export function hostFromEnv(env: Env = process.env): string {
  return setting(env, "HOST") ?? DEFAULT_HOST;
}

export function logLevelFromEnv(env: Env = process.env): LogLevel {
  const raw = setting(env, "LOG_LEVEL");
  if (raw === undefined) return "info";
  const level = raw.toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} (got "${raw}")`);
  }
  return level as LogLevel;
}

/** The only setting the add_user CLI needs. */
export function databasePathFromEnv(env: Env = process.env): string {
  return setting(env, "DATABASE_PATH") ?? DEFAULT_DATABASE_PATH;
}

/**
 * Session lifetime from SESSION_TTL_HOURS (default 7 days). Invalid values fail
 * loudly: silently producing NaN or a past expiry would break every login.
 */
export function sessionTtlMs(env: Env = process.env): number {
  const raw = setting(env, "SESSION_TTL_HOURS");
  if (raw === undefined) return DEFAULT_SESSION_TTL_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_SESSION_TTL_HOURS) {
    throw new Error(`SESSION_TTL_HOURS must be a number of hours between 0 and ${MAX_SESSION_TTL_HOURS} (got "${raw}")`);
  }
  return Math.round(hours * 60 * 60 * 1000);
}

export function cookieSecureFromEnv(env: Env = process.env): boolean | null {
  const raw = setting(env, "COOKIE_SECURE");
  if (raw === undefined) return null;
  const value = raw.toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`COOKIE_SECURE must be true, 1, false or 0, or unset to detect HTTPS (got "${raw}")`);
}
