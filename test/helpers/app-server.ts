/**
 * Helpers for integration tests that run the real server as a child process:
 * start it against a (fake) ThinQ API with a throwaway database, provision
 * users with the add_user CLI, call the API with a session cookie, and read
 * Server-Sent Event streams.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const ROOT = join(import.meta.dirname, "..", "..");

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export async function waitFor<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export interface AppServer {
  base: string;
  process: ChildProcess;
  /** Resolves with the exit code once the server process ends. */
  exited: Promise<number | null>;
  addUser(username: string, password: string, options?: { force?: boolean }): Promise<string>;
  stop(): Promise<void>;
}

/** Start the server against `thinqUrl`. Extra env wins over the defaults. */
export async function startAppServer(thinqUrl: string, extraEnv: Record<string, string> = {}): Promise<AppServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "lg-home-test-"));
  const port = await freePort();
  const env = {
    ...process.env,
    DATABASE_PATH: join(dataDir, "test.db"),
    LOG_LEVEL: "error",
    PORT: String(port),
    THINQ_ACCESS_TOKEN: "pat-test",
    THINQ_COUNTRY_CODE: "US",
    THINQ_API_BASE_URL: thinqUrl,
    ...extraEnv,
  };

  const addUser = async (username: string, password: string, options: { force?: boolean } = {}) => {
    const args = ["--import", "tsx", "src/server/cli/add-user.ts", username, "--password", password];
    if (options.force) args.push("--force");
    return (await run(process.execPath, args, { cwd: ROOT, env })).stdout;
  };

  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const base = `http://127.0.0.1:${port}`;

  let up = false;
  for (let i = 0; i < 100 && !up && child.exitCode === null; i++) {
    try {
      await fetch(`${base}/api/auth/me`);
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!up) {
    child.kill();
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error("server did not start");
  }

  return {
    base,
    process: child,
    exited,
    addUser,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** An API client holding one session cookie. */
export class ApiClient {
  cookie = "";
  constructor(readonly base: string) {}

  async request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...init.headers };
    if (init.body) headers["Content-Type"] = "application/json";
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(`${this.base}${path}`, { ...init, headers });
    const text = await res.text();
    return { res, status: res.status, body: text ? JSON.parse(text) : null };
  }

  async login(username: string, password: string) {
    const { res, status } = await this.request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
    if (status !== 200) throw new Error(`login failed: ${status}`);
    this.cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  }

  stream(path = "/api/events/stream", headers: Record<string, string> = {}) {
    return openEventStream(`${this.base}${path}`, { ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers });
  }
}

export interface SseMessage {
  id?: string;
  event?: string;
  data?: string;
  retry?: string;
}

export interface EventStream {
  status: number;
  headers: Headers;
  /** Every message received so far (comments excluded). */
  messages: SseMessage[];
  /** Heartbeat comments received. */
  comments: number;
  /** Resolves when the server ends the stream. */
  ended: Promise<void>;
  /** Wait for a message (already received or future) that matches. */
  next(match: (m: SseMessage) => boolean, what: string, timeoutMs?: number): Promise<SseMessage>;
  close(): void;
}

/** A minimal Server-Sent Events client on top of fetch. */
export async function openEventStream(url: string, headers: Record<string, string>): Promise<EventStream> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const messages: SseMessage[] = [];
  const stream: EventStream = {
    status: res.status,
    headers: res.headers,
    messages,
    comments: 0,
    ended: Promise.resolve(),
    next: (match, what, timeoutMs = 5000) => waitFor(() => messages.find(match), what, timeoutMs),
    close: () => controller.abort(),
  };
  if (!res.ok || !res.body) {
    await res.text().catch(() => {});
    return stream;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  stream.ended = (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const message: SseMessage = {};
          let comment = false;
          for (const line of frame.split("\n")) {
            if (line.startsWith(":")) {
              comment = true;
              continue;
            }
            const colon = line.indexOf(":");
            const field = line.slice(0, colon) as keyof SseMessage;
            const value = line.slice(colon + 1).replace(/^ /, "");
            message[field] = message[field] === undefined ? value : `${message[field]}\n${value}`;
          }
          if (comment && Object.keys(message).length === 0) stream.comments++;
          else messages.push(message);
        }
      }
    } catch {
      // aborted by close()
    }
  })();
  return stream;
}

/** The JSON payload of an event message. */
export function eventData(message: SseMessage): {
  id: number;
  deviceId: string;
  kind: string;
  payload: Record<string, unknown> & { changes?: { path: string; from: unknown; to: unknown }[] };
  createdAt: string;
} {
  return JSON.parse(message.data ?? "null");
}
