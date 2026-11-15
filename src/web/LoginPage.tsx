import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type User } from "./api";

/** Credential gate: nothing else in the app renders until this succeeds. */
export function LoginPage() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: () => api.login(username, password),
    onSuccess: (user: User) => {
      setPassword("");
      // Hand the user to the app shell, which swaps in the devices page.
      queryClient.setQueryData(["me"], user);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!login.isPending) login.mutate();
  }

  return (
    <main className="login">
      <form className="card" onSubmit={onSubmit} noValidate>
        <h1>LG Home</h1>
        <p className="muted">Sign in to control your appliances.</p>

        {login.error && (
          <p className="error" role="alert">
            {login.error.message}
          </p>
        )}

        <label htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          autoFocus
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={login.isPending}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={login.isPending}
        />

        <button type="submit" className="primary" disabled={login.isPending || !username || !password}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>

        <p className="muted hint">
          Accounts are created by an admin with <code>npm run add_user</code>.
        </p>
      </form>
    </main>
  );
}
