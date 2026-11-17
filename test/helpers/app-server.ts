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

/**
 * How long the server may take to start answering. Starting runs TypeScript
 * through tsx, whose module resolution alone takes seconds, and test files run
 * in parallel: on a loaded machine startup has taken well over 10 s. A server
 * that crashes is reported at once, not after this deadline. Slower machines
 * (e.g. CI) can raise it with TEST_SERVER_STARTUP_TIMEOUT_MS.
 */
export const STARTUP_TIMEOUT_MS = Number(process.env.TEST_SERVER_STARTUP_TIMEOUT_MS) || 60_000;
/** Server output kept for the error message when it fails to start. */
const OUTPUT_TAIL_CHARS = 4_000;

export interface AppServer {
  base: string;
  process: ChildProcess;
  /** Resolves with the exit code once the server process ends. */
  exited: Promise<number | null>;
  addUser(username: string, password: string, options?: { force?: boolean }): Promise<string>;
  stop(): Promise<void>;
}

/**
 * Start the server against `thinqUrl` and wait until it answers HTTP. Extra env
 * wins over the defaults. Throws with the server's exit code and last output
 * when it exits first, or when it isn't up within `startupTimeoutMs`.
 */
export async function startAppServer(
  thinqUrl: string,
  extraEnv: Record<string, string> = {},
  { startupTimeoutMs = STARTUP_TIMEOUT_MS }: { startupTimeoutMs?: number } = {},
): Promise<AppServer> {
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
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Pass the server's output through, keeping the end of it for error messages.
  let output = "";
  const keep = (target: NodeJS.WriteStream) => (chunk: Buffer) => {
    target.write(chunk);
    output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
  };
  child.stdout!.on("data", keep(process.stdout));
  child.stderr!.on("data", keep(process.stderr));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const base = `http://127.0.0.1:${port}`;

  const started = Date.now();
  let lastError: unknown;
  for (;;) {
    try {
      await fetch(`${base}/api/auth/me`, { signal: AbortSignal.timeout(2_000) });
      break;
    } catch (err) {
      lastError = err;
    }
    const problem =
      child.exitCode !== null || child.signalCode !== null
        ? `exited during startup (code ${child.exitCode}, signal ${child.signalCode})`
        : Date.now() - started > startupTimeoutMs
          ? `did not answer within ${startupTimeoutMs / 1000} s (last attempt: ${describe(lastError)})`
          : null;
    if (problem) {
      child.kill();
      rmSync(dataDir, { recursive: true, force: true });
      throw new Error(`server on port ${port} ${problem}\n--- server output (end) ---\n${output || "(none)"}`);
    }
    await new Promise((r) => setTimeout(r, 100));
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

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
  return `${err.message}${cause}`;
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
