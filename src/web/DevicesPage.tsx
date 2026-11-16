import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Device, type User } from "./api";
import { DeviceEvents } from "./DeviceEvents";
import { EventsPage } from "./EventsPage";
import { useSubscriptions } from "./events/cache";
import { EventStreamProvider, type EventSourceFactory } from "./events/stream";

type Tab = "devices" | "events";

const tabFromLocation = (): Tab => (window.location.hash === "#events" ? "events" : "devices");

/** The app proper, shown once a user is signed in. */
export function DevicesPage({ user, createEventSource }: { user: User; createEventSource?: EventSourceFactory }) {
  const queryClient = useQueryClient();
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices });
  const sync = useMutation({
    mutationFn: api.syncDevices,
    onSuccess: (data) => queryClient.setQueryData(["devices"], data),
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      queryClient.setQueryData(["me"], null);
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    },
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTabState] = useState<Tab>(tabFromLocation);
  const [eventsDevice, setEventsDevice] = useState("");

  // The tab lives in the URL hash, so reloading and Back work.
  useEffect(() => {
    const onPop = () => setTabState(tabFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const setTab = (next: Tab, deviceId = "") => {
    setEventsDevice(deviceId);
    if (next === tab) return;
    setTabState(next);
    const url = next === "events" ? "#events" : window.location.pathname + window.location.search;
    window.history.pushState(null, "", url);
  };

  const selectedDevice = devices.data?.find((d) => d.id === selected);

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
          {(["devices", "events"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={t === tab ? "active" : undefined}
              aria-current={t === tab ? "page" : undefined}
              onClick={() => setTab(t)}
            >
              {t === "devices" ? "Devices" : "Events"}
            </button>
          ))}
        </nav>

        {sync.error && <p className="error">{sync.error.message}</p>}

        {tab === "devices" ? (
          <>
            {devices.error && <p className="error">{devices.error.message}</p>}
            {devices.data?.length === 0 && <p>No devices yet. Click “Sync from ThinQ”.</p>}
            <DeviceList devices={devices.data ?? []} selected={selected} onSelect={setSelected} />
            {selectedDevice && (
              <>
                <DeviceStatus id={selectedDevice.id} />
                <DeviceEvents device={selectedDevice} onShowAll={(id) => setTab("events", id)} />
              </>
            )}
          </>
        ) : (
          <EventsPage key={eventsDevice} initialDeviceId={eventsDevice} />
        )}
      </main>
    </EventStreamProvider>
  );
}

function DeviceList({ devices, selected, onSelect }: { devices: Device[]; selected: string | null; onSelect: (id: string) => void }) {
  const subscriptions = useSubscriptions();
  const watched = new Set(subscriptions.data?.subscriptions.map((s) => s.deviceId));
  return (
    <ul className="devices">
      {devices.map((d) => (
        <li key={d.id}>
          <button className={d.id === selected ? "active" : ""} onClick={() => onSelect(d.id)}>
            <span className="device-head">
              <strong>{d.alias}</strong>
              {watched.has(d.id) && <span className="badge">Watching</span>}
            </span>
            <span>{prettyType(d)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function DeviceStatus({ id }: { id: string }) {
  const status = useQuery({ queryKey: ["status", id], queryFn: () => api.status(id), refetchInterval: 30_000 });
  return (
    <section>
      <h2>Status</h2>
      {status.isPending && <p>Loading…</p>}
      {status.error && <p className="error">{status.error.message}</p>}
      {status.data && <pre>{JSON.stringify(status.data, null, 2)}</pre>}
    </section>
  );
}

function prettyType(d: Device) {
  return d.type.replace(/^DEVICE_/, "").replace(/_/g, " ").toLowerCase();
}
