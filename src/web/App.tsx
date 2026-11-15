import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { LoginPage } from "./LoginPage";
import { DevicesPage } from "./DevicesPage";

/**
 * Auth gate: ask the server who we are, then show either the login page or the
 * devices page. `/api/auth/me` is the single source of truth, so a stale tab
 * falls back to the login page as soon as the session expires.
 */
export function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false, staleTime: 60_000 });

  if (me.isPending) {
    return (
      <main className="login">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (me.error) {
    return (
      <main className="login">
        <p className="error">{me.error.message}</p>
      </main>
    );
  }

  return me.data ? <DevicesPage user={me.data} /> : <LoginPage />;
}
