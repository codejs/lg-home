export interface Device {
  id: string;
  type: string;
  alias: string;
  modelName: string | null;
  reportable: boolean | null;
  updatedAt: string;
}

export interface User {
  id: number;
  username: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Called when the server rejects a request because the session is gone. */
let onUnauthorized: (() => void) | undefined;

export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin", // carry the session cookie
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // An expired session on a normal call should bounce the user to the login
    // page; a rejected login is handled by the login form itself.
    if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized?.();
    throw new ApiError(data?.error ?? data?.message ?? `${res.status} ${res.statusText}`, res.status);
  }
  return data as T;
}

export const api = {
  /** Current user, or null when not signed in. */
  me: async (): Promise<User | null> => {
    try {
      const { user } = await request<{ user: User }>("/api/auth/me");
      return user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
  login: async (username: string, password: string): Promise<User> => {
    const { user } = await request<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return user;
  },
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),

  devices: () => request<Device[]>("/api/devices"),
  syncDevices: () => request<Device[]>("/api/devices/sync", { method: "POST" }),
  status: (id: string) => request<Record<string, unknown>>(`/api/devices/${id}/status`),
  control: (id: string, command: Record<string, unknown>) =>
    request(`/api/devices/${id}/control`, { method: "POST", body: JSON.stringify(command) }),
};
