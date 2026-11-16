import { normalizeUsername } from "./auth.js";

export interface LoginThrottleOptions {
  /** Failures allowed per key within the window before further attempts are refused. */
  maxAttempts?: number;
  windowMs?: number;
  /** Upper bound on tracked keys, so a flood of distinct usernames can't exhaust memory. */
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  count: number;
  firstAt: number;
}

/**
 * In-memory brute-force brake for the login endpoint: after `maxAttempts`
 * failures for one client IP + account, further attempts are refused until the
 * window (counted from the first failure) has passed. State resets on restart.
 */
export class LoginThrottle {
  readonly maxAttempts: number;
  readonly windowMs: number;
  readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(options: LoginThrottleOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 10;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * The throttle key. The username is normalised exactly like login does, so
   * " Alice " and "alice" share one budget: they reach the same account.
   */
  key(ip: string, username: string): string {
    return `${ip}|${normalizeUsername(username)}`;
  }

  isBlocked(key: string): boolean {
    const entry = this.live(key);
    return entry !== undefined && entry.count >= this.maxAttempts;
  }

  recordFailure(key: string): void {
    const entry = this.live(key);
    if (entry) {
      entry.count += 1;
      return;
    }
    if (this.entries.size >= this.maxEntries) this.evict();
    this.entries.set(key, { count: 1, firstAt: this.now() });
  }

  /** Forget a key, e.g. after a successful login. */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Number of tracked keys (for tests and diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.firstAt >= this.windowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Drop expired entries; if still full, drop the oldest (Map keeps insertion order). */
  private evict(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.firstAt >= this.windowMs) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
