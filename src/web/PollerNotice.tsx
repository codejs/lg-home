import type { PollerStatus } from "./api";
import { formatTime } from "./events/format";

/** Shown while the server has paused polling ThinQ (rate limit, bad token, outage). */
export function PollerNotice({ poller }: { poller: PollerStatus | undefined }) {
  if (!poller || poller.state !== "paused") return null;
  return (
    <p className="error" role="status">
      Checking devices for changes is paused{poller.resumesAt ? ` until ${formatTime(poller.resumesAt)}` : ""}
      {poller.lastError ? `: ${poller.lastError}` : "."}
    </p>
  );
}
