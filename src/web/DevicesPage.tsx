import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Device, type User } from "./api";

/** The app proper, shown once a user is signed in. */
export function DevicesPage({ user }: { user: User }) {
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

  return (
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
      {sync.error && <p className="error">{sync.error.message}</p>}
      {devices.error && <p className="error">{devices.error.message}</p>}
      {devices.data?.length === 0 && <p>No devices yet. Click “Sync from ThinQ”.</p>}

      <ul className="devices">
        {devices.data?.map((d) => (
          <li key={d.id}>
            <button className={d.id === selected ? "active" : ""} onClick={() => setSelected(d.id)}>
              <strong>{d.alias}</strong>
              <span>{prettyType(d)}</span>
            </button>
          </li>
        ))}
      </ul>

      {selected && <DeviceStatus id={selected} />}
    </main>
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
