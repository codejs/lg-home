export interface Device {
  id: string;
  type: string;
  alias: string;
  modelName: string | null;
  reportable: boolean | null;
  updatedAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  devices: () => request<Device[]>("/api/devices"),
  syncDevices: () => request<Device[]>("/api/devices/sync", { method: "POST" }),
  status: (id: string) => request<Record<string, unknown>>(`/api/devices/${id}/status`),
  control: (id: string, command: Record<string, unknown>) =>
    request(`/api/devices/${id}/control`, { method: "POST", body: JSON.stringify(command) }),
};
