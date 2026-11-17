import { LoginPage } from "./LoginPage";
import { DevicesPage } from "./DevicesPage";
import { useMe } from "./queries";

/**
 * Auth gate: ask the server who we are, then show either the login page or the
 * devices page. `/api/auth/me` is the single source of truth, so a stale tab
 * falls back to the login page as soon as the session expires.
 */
export function App() {
  const me = useMe();

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
