/**
 * Watches subscribed devices for state changes by polling ThinQ.
 *
 * Every cycle reads the state of each subscribed device (one
 * `GET /devices/{id}/state` per device, one device at a time) and hands it to
 * the store, which diffs it against the last known state and records an event
 * when something changed. The poller only ever reads: it never controls a device.
 *
 * ThinQ limits API calls per account and may block clients that misbehave, so
 * each device is polled at most once per interval - however often a cycle is
 * triggered or a device is re-subscribed - and failures slow polling down
 * instead of retrying hard:
 *   - device-level errors (device offline, removed from the account) back off
 *     that device only, doubling up to MAX_DEVICE_BACKOFF_MS;
 *   - anything else (rate limit, bad token, ThinQ down, unknown errors, missing
 *     configuration) pauses all polling, doubling up to MAX_GLOBAL_BACKOFF_MS,
 *     and ends the current cycle so no further calls are made.
 */
import { ThinQConfigError, ThinQError, type ThinQClient } from "../thinq/client.js";
import { checkState } from "./diff.js";
import { applySnapshot, markPollError, subscribedDeviceIds } from "./store.js";

export const MAX_DEVICE_BACKOFF_MS = 15 * 60_000;
export const MAX_GLOBAL_BACKOFF_MS = 30 * 60_000;

/**
 * ThinQ error codes that concern one device rather than the account or the
 * service. Anything not listed pauses all polling (the conservative choice).
 */
export const DEVICE_ERROR_CODES: ReadonlySet<string> = new Set([
  "1205", // NOT_EXIST_DEVICE
  "1211", // NOT_REGISTERED_DEVICE_BY_USER
  "1212", // NOT_OWNED_DEVICE
  "1213", // NOT_REGISTERED_DEVICE
  "1217", // ALREADY_DEVICE_DELETED
  "1219", // NOT_SUPPORTED_MODEL
  "1221", // NOT_SUPPORTED_PRODUCT
  "1222", // NOT_CONNECTED_DEVICE
  "1223", // INVALID_STATUS_DEVICE
  "1224", // INVALID_DEVICE_ID
  "2205", // INVALID_DEVICE_STATUS
  "2209", // DEVICE_RESPONSE_DELAY
]);

export type PollerState = "idle" | "paused" | "stopped";

export interface PollerStatus {
  state: PollerState;
  intervalMs: number;
  /** While paused: when polling resumes. */
  resumesAt: Date | null;
  lastCycleAt: Date | null;
  /** Why polling is paused (account/service-level problem). */
  lastError: string | null;
}

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface PollerOptions {
  intervalMs: number;
  /** The ThinQ client; may throw ThinQConfigError when not configured. */
  client: () => ThinQClient;
  log: Logger;
  /** Clock in ms since epoch (injectable for tests). */
  now?: () => number;
}

interface DeviceSchedule {
  /** Consecutive device-level failures. */
  failures: number;
  /** Earliest time the device may be polled again. */
  nextPollAt: number;
}

export class EventPoller {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly devices = new Map<string, DeviceSchedule>();
  private globalFailures = 0;
  private pausedUntil = 0;
  private lastCycleAt: number | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private started = false;
  private stopped = false;

  constructor(private readonly options: PollerOptions) {
    if (!(Number.isFinite(options.intervalMs) && options.intervalMs > 0)) throw new Error("intervalMs must be positive");
    this.intervalMs = options.intervalMs;
    this.now = options.now ?? Date.now;
  }

  /** Start polling: a first cycle right away, then one every interval. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(0);
  }

  /** Stop polling and wait for an in-flight cycle to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Poll soon (e.g. after a new subscription), without waiting for the interval. */
  trigger(): void {
    if (!this.started || this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.schedule(0);
  }

  status(): PollerStatus {
    const paused = this.pausedUntil > this.now();
    return {
      state: this.stopped ? "stopped" : paused ? "paused" : "idle",
      intervalMs: this.intervalMs,
      resumesAt: paused ? new Date(this.pausedUntil) : null,
      lastCycleAt: this.lastCycleAt === null ? null : new Date(this.lastCycleAt),
      lastError: this.lastError,
    };
  }

  /**
   * Run one polling cycle. Never runs two at once: a call while a cycle is in
   * flight waits for that cycle instead. Never throws.
   */
  runCycle(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.cycle()
      .catch((err) => this.options.log.error({ err }, "event poller cycle failed"))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  // -------------------------------------------------------------------------

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle().then(() => {
        if (this.stopped) return;
        if (this.rerun) {
          this.rerun = false;
          this.schedule(0);
          return;
        }
        const wait = Math.max(this.intervalMs, this.pausedUntil - this.now());
        this.schedule(wait);
      });
    }, delayMs);
    // Polling alone must not keep the process alive.
    this.timer.unref();
  }

  private async cycle(): Promise<void> {
    const start = this.now();
    if (this.pausedUntil > start) return;
    this.lastCycleAt = start;

    const subscribed = subscribedDeviceIds();
    // Entries of unsubscribed devices are kept until they no longer hold a
    // device back, so unsubscribing and re-subscribing can't force extra calls.
    for (const [id, s] of this.devices) {
      if (s.nextPollAt <= start && !subscribed.includes(id)) this.devices.delete(id);
    }
    const due = subscribed.filter((id) => (this.devices.get(id)?.nextPollAt ?? 0) <= start);
    if (due.length === 0) return;

    let client: ThinQClient;
    try {
      client = this.options.client();
    } catch (err) {
      this.pauseAll(err);
      return;
    }

    for (const deviceId of due) {
      if (this.stopped) return;

      let state: Record<string, unknown>;
      try {
        state = await client.getDeviceStatus(deviceId);
      } catch (err) {
        if (isDeviceError(err)) {
          this.deviceFailed(deviceId, err);
          continue;
        }
        this.pauseAll(err);
        return; // no more calls this cycle
      }

      this.globalFailures = 0;
      this.lastError = null;
      const problem = checkState(state);
      if (problem) {
        this.deviceFailed(deviceId, new Error(`Ignored a state from ThinQ: ${problem}`));
        continue;
      }
      this.devices.set(deviceId, { failures: 0, nextPollAt: this.now() + this.intervalMs });
      const event = applySnapshot(deviceId, state, new Date(this.now()));
      if (event) this.options.log.info({ deviceId, eventId: event.id }, "device state changed");
    }
  }

  private deviceFailed(deviceId: string, err: unknown): void {
    const failures = (this.devices.get(deviceId)?.failures ?? 0) + 1;
    const delay = Math.min(this.intervalMs * 2 ** (failures - 1), MAX_DEVICE_BACKOFF_MS);
    this.devices.set(deviceId, { failures, nextPollAt: this.now() + delay });
    markPollError(deviceId, describe(err), new Date(this.now()));
    this.options.log.warn({ deviceId, failures, retryInMs: delay, ...errorFields(err) }, "event poll failed for device");
  }

  private pauseAll(err: unknown): void {
    this.globalFailures++;
    const delay = Math.min(this.intervalMs * 2 ** (this.globalFailures - 1), MAX_GLOBAL_BACKOFF_MS);
    this.pausedUntil = this.now() + delay;
    this.lastError = describe(err);
    const log = err instanceof ThinQConfigError ? this.options.log.error : this.options.log.warn;
    log.call(this.options.log, { failures: this.globalFailures, pauseMs: delay, ...errorFields(err) }, "event polling paused");
  }
}

function isDeviceError(err: unknown): boolean {
  return err instanceof ThinQError && err.reason === "response" && err.code !== null && DEVICE_ERROR_CODES.has(err.code);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorFields(err: unknown): object {
  if (err instanceof ThinQError) return { reason: err.reason, thinqStatus: err.status, thinqCode: err.code, error: err.message };
  return { error: describe(err) };
}
