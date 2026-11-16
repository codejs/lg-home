import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Device } from "./api";
import { EventList } from "./EventList";
import { PollerNotice } from "./PollerNotice";
import { useEventHistory, useSubscriptions } from "./events/cache";
import { formatTime } from "./events/format";

export const RECENT_EVENTS = 5;

/** The "Events" part of a device's panel: watch / stop watching, and its latest events. */
export function DeviceEvents({ device, onShowAll }: { device: Device; onShowAll: (deviceId: string) => void }) {
  const queryClient = useQueryClient();
  const subscriptions = useSubscriptions();
  const subscription = subscriptions.data?.subscriptions.find((s) => s.deviceId === device.id);
  const recent = useEventHistory({ deviceId: device.id }, RECENT_EVENTS);

  const toggle = useMutation({
    mutationFn: () => (subscription ? api.unsubscribe(device.id) : api.subscribe(device.id)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["subscriptions"] }),
  });

  const events = recent.data?.pages.flat().slice(0, RECENT_EVENTS) ?? [];

  return (
    <section className="device-events" aria-labelledby="device-events-title">
      <div className="section-head">
        <h2 id="device-events-title">Events</h2>
        <button
          type="button"
          className={subscription ? undefined : "primary"}
          onClick={() => toggle.mutate()}
          disabled={subscriptions.isPending || toggle.isPending}
        >
          {toggle.isPending ? "Saving…" : subscription ? "Stop watching" : "Watch state changes"}
        </button>
      </div>

      {subscriptions.error && <p className="error">{subscriptions.error.message}</p>}
      {toggle.error && <p className="error">{toggle.error.message}</p>}

      {subscription ? (
        <>
          <p className="muted">
            Watching since {formatTime(subscription.createdAt)}
            {subscription.createdBy ? ` (by ${subscription.createdBy})` : ""}.{" "}
            {subscription.lastPolledAt ? `Last checked ${formatTime(subscription.lastPolledAt)}.` : "Waiting for the first check."}
            {subscription.lastChangeAt ? ` Last change ${formatTime(subscription.lastChangeAt)}.` : ""}
          </p>
          {subscription.lastError && (
            <p className="error">
              Last check failed{subscription.lastErrorAt ? ` (${formatTime(subscription.lastErrorAt)})` : ""}: {subscription.lastError}
            </p>
          )}
          <PollerNotice poller={subscriptions.data?.poller} />
        </>
      ) : (
        subscriptions.data && <p className="muted">Not watched. Watch this device to record its state changes as events.</p>
      )}

      {recent.error && <p className="error">{recent.error.message}</p>}
      {recent.isPending ? (
        <p className="muted">Loading events…</p>
      ) : (
        <EventList events={events} showDevice={false} emptyText="No events for this device yet." />
      )}
      {events.length > 0 && (
        <button type="button" onClick={() => onShowAll(device.id)}>
          Show all events
        </button>
      )}
    </section>
  );
}
