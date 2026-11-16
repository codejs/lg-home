import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type User } from "./api";
import { DeviceCard } from "./DeviceCard";

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

      <ul className="device-grid" aria-label="Devices">
        {devices.data?.map((d) => (
          <li key={d.id}>
            <DeviceCard device={d} />
          </li>
        ))}
      </ul>
    </main>
  );
}
