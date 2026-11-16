/**
 * Deletes state-change events older than the retention period: once at
 * startup, then hourly. Control records are kept (they are an audit trail).
 */
import type { Logger } from "./poller.js";
import { pruneEvents } from "./store.js";

const SWEEP_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export function startRetention(retentionDays: number, log: Logger, now: () => number = Date.now): () => void {
  const sweep = () => {
    try {
      const deleted = pruneEvents(new Date(now() - retentionDays * DAY_MS));
      if (deleted > 0) log.info({ deleted, retentionDays }, "pruned old device events");
    } catch (err) {
      log.error({ err }, "pruning device events failed");
    }
  };
  sweep();
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
