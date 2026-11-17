import type { DeviceEvent } from "./api";
import { summarizeEvent } from "./events/format";
import { formatFullTimestamp, formatTimestamp } from "./time";

const KIND_LABELS: Record<string, string> = { event: "State", control: "Command" };

/** Device events, newest first. Everything from the event is rendered as text. */
export function EventList({
  events,
  aliases,
  showDevice = true,
  emptyText = "No events yet.",
}: {
  events: DeviceEvent[];
  /** Device id -> display name. */
  aliases?: ReadonlyMap<string, string>;
  showDevice?: boolean;
  emptyText?: string;
}) {
  if (events.length === 0) return <p className="muted">{emptyText}</p>;
  return (
    <ol className="events" aria-label="Device events">
      {events.map((event) => (
        <EventItem
          key={event.id}
          event={event}
          device={showDevice ? (event.deviceId ? (aliases?.get(event.deviceId) ?? event.deviceId) : "Unknown device") : null}
        />
      ))}
    </ol>
  );
}

function EventItem({ event, device }: { event: DeviceEvent; device: string | null }) {
  const summary = summarizeEvent(event);
  return (
    <li className={`event event-${event.kind === "control" ? "control" : "state"}`}>
      <div className="event-head">
        <span className="badge">{KIND_LABELS[event.kind] ?? event.kind}</span>
        {device !== null && <strong className="event-device">{device}</strong>}
        <span>{summary.title}</span>
        <time className="muted" dateTime={event.createdAt} title={formatFullTimestamp(event.createdAt)}>
          {formatTimestamp(event.createdAt)}
        </time>
      </div>
      {summary.lines.length > 0 && (
        <ul className="event-lines">
          {/* Readable text; the device's own names are in the tooltip and under Details. */}
          {summary.lines.map((line, i) => (
            <li key={i} title={line.raw}>
              {line.text}
            </li>
          ))}
        </ul>
      )}
      {summary.more > 0 && <p className="muted event-more">+{summary.more} more</p>}
      <details>
        <summary>Details</summary>
        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
      </details>
    </li>
  );
}
