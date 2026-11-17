import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Device, type User } from "./api";
import { DeviceCard } from "./DeviceCard";
import { DeviceEvents } from "./DeviceEvents";
import { EventsPage } from "./EventsPage";
import { useSubscriptions } from "./events/cache";
import { queryKeys, signOutLocally, useDevices } from "./queries";
import { EventStreamProvider, type EventSourceFactory } from "./events/stream";
import { useHashTab } from "./useHashTab";

const TABS = ["devices", "events"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { devices: "Devices", events: "Events" };

const EVENTS_PANEL_ID = "device-events-panel";

/** The app proper, shown once a user is signed in. */
export function DevicesPage({ user, createEventSource }: { user: User; createEventSource?: EventSourceFactory }) {
  const queryClient = useQueryClient();
  const devices = useDevices();
  const sync = useMutation({
    mutationFn: api.syncDevices,
    onSuccess: (data) => queryClient.setQueryData(queryKeys.devices, data),
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => signOutLocally(queryClient),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, showTab] = useHashTab(TABS, "devices");
  // The Events tab opens filtered to this device ("" = all devices).
  const [eventsDevice, setEventsDevice] = useState("");
  const setTab = (next: Tab, deviceId = "") => {
    setEventsDevice(deviceId);
    showTab(next);
  };

  return (
    <EventStreamProvider createEventSource={createEventSource}>
      <main>
        <header>
          <h1>LG Home</h1>
          <div className="header-actions">
            <button onClick={() => sync.mutate()} disabled={sync.isPending}>
              {sync.isPending ? "Syncing…" : "Sync from ThinQ"}
            </button>
            <span className="muted">{user.username}</span>
            <button onClick={() => logout.mutate()} disabled={logout.isPending}>
              Sign out
            </button>
          </div>
        </header>

        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              className={t === tab ? "active" : undefined}
              aria-current={t === tab ? "page" : undefined}
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>

        {sync.error && <p className="error">{sync.error.message}</p>}

        {tab === "devices" ? (
          <>
            {devices.error && <p className="error">{devices.error.message}</p>}
            {devices.data?.length === 0 && <p>No devices yet. Click “Sync from ThinQ”.</p>}
            <DeviceGrid
              devices={devices.data ?? []}
              selected={selected}
              onSelect={setSelected}
              onShowAll={(id) => setTab("events", id)}
            />
          </>
        ) : (
          <EventsPage key={eventsDevice} initialDeviceId={eventsDevice} />
        )}
      </main>
    </EventStreamProvider>
  );
}

/**
 * A card per device; a card's Events button opens that device's events panel
 * below the grid (one at a time; pressing it again closes the panel).
 */
function DeviceGrid({
  devices,
  selected,
  onSelect,
  onShowAll,
}: {
  devices: Device[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onShowAll: (deviceId: string) => void;
}) {
  const subscriptions = useSubscriptions();
  const watched = new Set(subscriptions.data?.subscriptions.map((s) => s.deviceId));
  const selectedDevice = devices.find((d) => d.id === selected);

  // The panel sits below every card: bring it into view when a device is picked.
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) panel.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [selected]);

  return (
    <>
      <ul className="device-grid" aria-label="Devices">
        {devices.map((d) => {
          const open = d.id === selected;
          return (
            <li key={d.id}>
              <DeviceCard
                device={d}
                highlighted={open}
                badges={watched.has(d.id) && <span className="badge">Watching</span>}
                actions={
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onSelect(open ? null : d.id)}
                    aria-expanded={open}
                    aria-controls={open ? EVENTS_PANEL_ID : undefined}
                    aria-label={`Events for ${d.alias}`}
                  >
                    Events
                  </button>
                }
              />
            </li>
          );
        })}
      </ul>
      <div ref={panel}>
        {selectedDevice && <DeviceEvents id={EVENTS_PANEL_ID} device={selectedDevice} onShowAll={onShowAll} />}
      </div>
    </>
  );
}
