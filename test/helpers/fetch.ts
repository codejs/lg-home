/**
 * A routing fetch() stub for web tests: `"METHOD /path"` -> handler. Unrouted
 * requests fail the test loudly. Every call is recorded.
 */
export interface FetchCall {
  method: string;
  url: string;
  init: RequestInit;
  body: unknown;
}

export type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

export function json(status: number, body: unknown, statusText = ""): Response {
  return new Response(JSON.stringify(body), { status, statusText, headers: { "Content-Type": "application/json" } });
}

/** A promise you resolve later, to observe pending UI states. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function installFetch(routes: Record<string, FetchHandler>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const call: FetchCall = { method, url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`Unexpected fetch: ${method} ${path}`);
    return handler(call);
  }) as typeof fetch;
  return {
    calls,
    routes,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
