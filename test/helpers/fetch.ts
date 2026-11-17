/**
 * The fetch() stub for web tests: `"METHOD /path?query"` -> handler. Requests
 * no route matches go to the fallback (e.g. FakeBackend) or, without one, fail
 * the test loudly. Every call is recorded.
 */
export interface FetchCall {
  method: string;
  /** As passed to fetch(), e.g. "/api/events?limit=5". */
  url: string;
  /** Path without the query string (still URL-encoded). */
  path: string;
  query: URLSearchParams;
  init: RequestInit;
  /** The parsed JSON request body, if any. */
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

export function installFetch(routes: Record<string, FetchHandler>, fallback?: FetchHandler) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const parsed = new URL(url, "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call: FetchCall = { method, url, path: parsed.pathname, query: parsed.searchParams, init, body };
    calls.push(call);
    const target = url.replace(/^https?:\/\/[^/]+/, "");
    const handler = routes[`${method} ${target}`] ?? fallback;
    if (!handler) throw new Error(`Unexpected fetch: ${method} ${target}`);
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
