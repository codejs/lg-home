import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, THINQ_NOT_CONNECTED, api, type Device } from "./api";
import { DeviceIcon } from "./DeviceIcon";
import { deviceTypeLabel, describeState, summarize, type DeviceSummary } from "./deviceFormat";

/** How often each card refreshes its live status (every refresh is also stored as history). */
export const STATUS_REFRESH_MS = 60_000;

/** One appliance: identity, headline state, key figures, alerts, and full details on demand. */
export function DeviceCard({ device }: { device: Device }) {
  const status = useQuery({
    queryKey: ["status", device.id],
    queryFn: () => api.status(device.id),
    refetchInterval: STATUS_REFRESH_MS,
  });
  // Not derived from device.id: aria-labelledby is a space-separated id list.
  const titleId = useId();
  const offline = status.error instanceof ApiError && status.error.thinqCode === THINQ_NOT_CONNECTED;
  const summary = status.data ? summarize(status.data) : null;
  const typeLabel = deviceTypeLabel(device.type);
  // Don't repeat the type when the user named the device after it ("Dishwasher").
  const subtitle = [typeLabel.toLowerCase() === device.alias.trim().toLowerCase() ? null : typeLabel, device.modelName]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="device-card" aria-labelledby={titleId} aria-busy={status.isFetching}>
      <header className="device-card-header">
        <DeviceIcon type={device.type} />
        <div className="device-card-title">
          <h2 id={titleId}>{device.alias}</h2>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        {offline ? (
          <StatusPill label="Offline" tone="off" />
        ) : (
          summary?.status && <StatusPill label={summary.status.label} tone={summary.status.tone} />
        )}
      </header>

      {status.isPending && (
        <div className="device-card-loading" role="status">
          Loading status…
        </div>
      )}

      {status.error &&
        (offline ? (
          <p className="muted">The appliance isn’t connected to ThinQ right now. Check its Wi-Fi or power.</p>
        ) : (
          <p className="error">{status.error.message}</p>
        ))}

      {summary && status.data && <Summary summary={summary} state={status.data} />}

      <footer className="device-card-footer">
        <span className="muted">
          {status.dataUpdatedAt ? `Updated ${formatTime(status.dataUpdatedAt)}` : "\u00a0"}
        </span>
        <button
          type="button"
          className="link-button"
          onClick={() => status.refetch()}
          disabled={status.isFetching}
          aria-label={`Refresh ${device.alias}`}
        >
          {status.isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </footer>
    </article>
  );
}

function Summary({ summary, state }: { summary: DeviceSummary; state: Record<string, unknown> }) {
  const groups = describeState(state);
  return (
    <>
      {summary.alerts.length > 0 && (
        <ul className="device-alerts" aria-label="Alerts">
          {summary.alerts.map((alert) => (
            <li key={alert}>{alert}</li>
          ))}
        </ul>
      )}

      {summary.highlights.length > 0 && (
        <dl className="device-highlights">
          {summary.highlights.map((h, i) => (
            <div key={`${h.label}-${i}`}>
              <dt>{h.label}</dt>
              <dd>
                {h.value}
                {h.hint && <small> {h.hint}</small>}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {summary.progress && <Progress {...summary.progress} />}

      {summary.features.length > 0 && (
        <ul className="device-features" aria-label="Active features">
          {summary.features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}

      {groups.length > 0 && (
        <details className="device-details">
          <summary>All details</summary>
          {groups.map((group) => (
            <section key={group.title || "overview"}>
              {group.title && <h3>{group.title}</h3>}
              <dl>
                {group.rows.map((row, i) => (
                  <div key={`${row.label}-${i}`}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <details className="device-raw">
            <summary>Raw data</summary>
            <pre>{JSON.stringify(state, null, 2)}</pre>
          </details>
        </details>
      )}
    </>
  );
}

function StatusPill({ label, tone }: { label: string; tone: string }) {
  return (
    <span className="status-pill" data-tone={tone}>
      {label}
    </span>
  );
}

function Progress({ remaining, total }: { remaining: number; total: number }) {
  const done = Math.round(((total - remaining) / total) * 100);
  return (
    <div
      className="device-progress"
      role="progressbar"
      aria-label="Programme progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={done}
      aria-valuetext={`${done}% done`}
    >
      <div style={{ width: `${done}%` }} />
    </div>
  );
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
