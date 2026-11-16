/**
 * A fake LG ThinQ Connect API for integration tests and offline development.
 *
 * ThinQ endpoints (same paths, headers and envelopes as the real service):
 *   GET  /devices                  -> the fake refrigerator and dishwasher
 *   GET  /devices/{id}/profile
 *   GET  /devices/{id}/state
 *   POST /devices/{id}/control     -> validated against the profile, changes state
 *
 * Scenario endpoints (fake only, no auth; local testing only):
 *   GET    /__fake/requests        -> recorded ThinQ requests
 *   POST   /__fake/reset           -> initial state, clear the request log and faults
 *   PATCH  /__fake/devices/{id}    -> { online?: boolean, state?: {...deep-merged} }
 *   GET    /__fake/faults          -> pending injected faults
 *   POST   /__fake/faults          -> { error: "EXCEEDED_API_CALLS", method?, path?, times?: n | "always" }
 *   DELETE /__fake/faults          -> clear injected faults
 *
 * Use in-process (`new FakeThinQ().listen()`) or standalone (`npm run fake-thinq`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FakeDishWasher, FakeRefrigerator, type FakeDevice } from "./devices.js";
import { ERRORS, FakeThinQError, type ErrorKind, type Json } from "./protocol.js";

/** LG's public x-api-key. Duplicated on purpose: the fake must not trust the client's constant. */
export const THINQ_PUBLIC_API_KEY = "v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3";

const REQUIRED_HEADERS = ["x-country", "x-client-id", "x-api-key", "x-service-phase", "x-message-id"] as const;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_REMEMBERED_MESSAGE_IDS = 10_000;

export interface FakeThinQOptions {
  /** Only accept this bearer token. By default any non-empty token is accepted. */
  accessToken?: string;
  /** Required x-api-key (defaults to LG's public key). */
  apiKey?: string;
  /** Clock in ms since epoch; tests pass a controllable one. */
  now?: () => number;
  /** With the default clock: run time this many times faster (e.g. 60 = 1 s per minute). */
  timeScale?: number;
  /** Called once per handled request, e.g. for console logging. */
  onRequest?: (entry: RecordedRequest) => void;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  status: number;
  errorCode?: string;
}

/**
 * Make matching ThinQ requests fail with a ThinQ error, e.g. to simulate rate
 * limiting or a revoked token. Faults apply after the request passed the
 * header checks, and are used up in the order they were added.
 */
export interface FaultSpec {
  /** The error to answer with. */
  error: ErrorKind;
  /** Only requests with this method (default: any). */
  method?: string;
  /** Only requests to this exact path, or matching this pattern (default: any). */
  path?: string | RegExp;
  /** How many matching requests fail (default 1; Infinity until cleared). */
  times?: number;
}

interface Fault {
  error: ErrorKind;
  method?: string;
  path?: string | RegExp;
  remaining: number;
}

export class FakeThinQ {
  readonly devices: FakeDevice[] = [new FakeRefrigerator(), new FakeDishWasher()];
  readonly requests: RecordedRequest[] = [];
  private readonly seenMessageIds = new Set<string>();
  private faults: Fault[] = [];
  private readonly server: Server;
  private readonly now: () => number;

  constructor(private readonly options: FakeThinQOptions = {}) {
    if (options.now) {
      this.now = options.now;
    } else {
      const scale = options.timeScale ?? 1;
      const origin = Date.now();
      this.now = () => origin + (Date.now() - origin) * scale;
    }
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.send(res, 500, { error: { code: "0000", message: String(err) } });
      });
    });
  }

  /** Start listening; resolves to the base URL. Port 0 picks a free port. */
  listen(port = 0, host = "127.0.0.1"): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => resolve(this.url));
    });
  }

  get url(): string {
    const { address, port } = this.server.address() as AddressInfo;
    return `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Back to the initial device state, with an empty request log and no faults. */
  reset(): void {
    for (const device of this.devices) device.reset();
    this.requests.length = 0;
    this.seenMessageIds.clear();
    this.faults = [];
  }

  /** Make upcoming matching requests fail; see {@link FaultSpec}. */
  injectFault(spec: FaultSpec): void {
    if (!(spec.error in ERRORS)) throw new Error(`Unknown fake error kind: ${spec.error}`);
    const times = spec.times ?? 1;
    if (!(times === Infinity || (Number.isInteger(times) && times > 0))) {
      throw new Error("times must be a positive integer or Infinity");
    }
    this.faults.push({ error: spec.error, method: spec.method?.toUpperCase(), path: spec.path, remaining: times });
  }

  clearFaults(): void {
    this.faults = [];
  }

  /** Faults that have not been used up yet. */
  get pendingFaults(): Readonly<Fault>[] {
    return this.faults.map((f) => ({ ...f }));
  }

  device(id: string): FakeDevice | undefined {
    return this.devices.find((d) => d.deviceId === id);
  }

  /** The first device of a ThinQ type, e.g. "DEVICE_REFRIGERATOR". */
  deviceOfType(type: string): FakeDevice {
    const device = this.devices.find((d) => d.deviceInfo.deviceType === type);
    if (!device) throw new Error(`No fake device of type ${type}`);
    return device;
  }

  // -------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    const method = req.method ?? "GET";
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      return this.fail(res, { method, path, headers: flatHeaders(req), body: undefined }, err);
    }

    if (path.startsWith("/__fake/")) return this.handleScenario(method, path, body, res);

    const entry = { method, path, headers: flatHeaders(req), body };
    try {
      this.authenticate(entry.headers);
      this.applyFault(method, path);
      const response = this.route(method, path, body);
      this.record(entry, 200);
      this.send(res, 200, { messageId: entry.headers["x-message-id"], timestamp: new Date(this.now()).toISOString(), response });
    } catch (err) {
      this.fail(res, entry, err);
    }
  }

  /** Header checks in the order the real service applies them. */
  private authenticate(headers: Record<string, string>): void {
    const auth = headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    if (!token || (this.options.accessToken !== undefined && token !== this.options.accessToken)) {
      throw new FakeThinQError("INVALID_TOKEN", "Invalid or missing access token");
    }
    for (const name of REQUIRED_HEADERS) {
      if (!headers[name]) throw new FakeThinQError("MISSING_PARAMETERS", `Missing header ${name}`);
    }
    if (headers["x-api-key"] !== (this.options.apiKey ?? THINQ_PUBLIC_API_KEY)) {
      throw new FakeThinQError("INCORRECT_HEADER", "Invalid x-api-key");
    }
    const messageId = headers["x-message-id"];
    if (!/^[A-Za-z0-9_-]{22}$/.test(messageId)) {
      throw new FakeThinQError("INVALID_MESSAGE_ID", "x-message-id must be 22 url-safe base64 characters");
    }
    if (this.seenMessageIds.has(messageId)) {
      throw new FakeThinQError("INVALID_MESSAGE_ID", "x-message-id was already used");
    }
    if (this.seenMessageIds.size >= MAX_REMEMBERED_MESSAGE_IDS) this.seenMessageIds.clear();
    this.seenMessageIds.add(messageId);
  }

  private applyFault(method: string, path: string): void {
    const index = this.faults.findIndex(
      (f) =>
        (!f.method || f.method === method) &&
        (f.path === undefined || (typeof f.path === "string" ? f.path === path : f.path.test(path))),
    );
    if (index === -1) return;
    const fault = this.faults[index];
    if (--fault.remaining <= 0) this.faults.splice(index, 1);
    throw new FakeThinQError(fault.error, `Injected fault: ${fault.error}`);
  }

  private route(method: string, path: string, body: unknown): unknown {
    if (method === "GET" && path === "/devices") return this.devices.map((d) => d.listing());

    const match = /^\/devices\/([^/]+)\/(profile|state|control)$/.exec(path);
    if (!match) throw new FakeThinQError("BAD_REQUEST", `No such endpoint: ${method} ${path}`, 404);
    const [, rawId, action] = match;
    const device = this.device(decodeURIComponent(rawId));
    if (!device) throw new FakeThinQError("NOT_EXIST_DEVICE", `Device ${decodeURIComponent(rawId)} does not exist`);

    if (method === "GET" && action === "profile") return structuredClone(device.profile);
    if ((method === "GET" && action === "state") || (method === "POST" && action === "control")) {
      if (!device.online) throw new FakeThinQError("NOT_CONNECTED_DEVICE", "Device is not connected");
      if (action === "state") return device.snapshot(this.now());
      device.control(body, this.now());
      return {};
    }
    throw new FakeThinQError("BAD_REQUEST", `No such endpoint: ${method} ${path}`, 404);
  }

  private handleScenario(method: string, path: string, body: unknown, res: ServerResponse): void {
    if (method === "GET" && path === "/__fake/requests") return this.send(res, 200, this.requests);
    if (method === "POST" && path === "/__fake/reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (path === "/__fake/faults") return this.handleFaults(method, body, res);
    const match = /^\/__fake\/devices\/([^/]+)$/.exec(path);
    if (method === "PATCH" && match) {
      const device = this.device(decodeURIComponent(match[1]));
      if (!device) return this.send(res, 404, { error: "unknown device" });
      const patch = (body ?? {}) as { online?: unknown; state?: unknown };
      if (typeof patch.online === "boolean") device.online = patch.online;
      if (patch.state && typeof patch.state === "object") device.patchState(patch.state as Json);
      return this.send(res, 200, { online: device.online, state: device.snapshot(this.now()) });
    }
    this.send(res, 404, { error: `No such scenario endpoint: ${method} ${path}` });
  }

  private handleFaults(method: string, body: unknown, res: ServerResponse): void {
    const list = () => this.pendingFaults.map((f) => ({ ...f, path: f.path?.toString(), remaining: f.remaining === Infinity ? "always" : f.remaining }));
    if (method === "GET") return this.send(res, 200, list());
    if (method === "DELETE") {
      this.clearFaults();
      return this.send(res, 200, { ok: true });
    }
    if (method !== "POST") return this.send(res, 404, { error: `No such scenario endpoint: ${method} /__fake/faults` });

    const spec = (body ?? {}) as { error?: unknown; method?: unknown; path?: unknown; times?: unknown };
    if (typeof spec.error !== "string" || !Object.hasOwn(ERRORS, spec.error)) {
      return this.send(res, 400, { error: `error must be one of ${Object.keys(ERRORS).join(", ")}` });
    }
    if (spec.method !== undefined && typeof spec.method !== "string") return this.send(res, 400, { error: "method must be a string" });
    if (spec.path !== undefined && typeof spec.path !== "string") return this.send(res, 400, { error: "path must be a string" });
    const times = spec.times === "always" ? Infinity : (spec.times ?? 1);
    if (!(times === Infinity || (typeof times === "number" && Number.isInteger(times) && times > 0))) {
      return this.send(res, 400, { error: 'times must be a positive integer or "always"' });
    }
    this.injectFault({ error: spec.error as ErrorKind, method: spec.method, path: spec.path, times });
    this.send(res, 201, list());
  }

  private fail(res: ServerResponse, entry: Omit<RecordedRequest, "status">, err: unknown): void {
    const error =
      err instanceof FakeThinQError ? err : new FakeThinQError("BAD_REQUEST", err instanceof Error ? err.message : String(err));
    this.record(entry, error.status, error.code);
    this.send(res, error.status, {
      messageId: entry.headers["x-message-id"] ?? "",
      timestamp: new Date(this.now()).toISOString(),
      error: { code: error.code, message: error.message },
    });
  }

  private record(entry: Omit<RecordedRequest, "status">, status: number, errorCode?: string): void {
    const recorded: RecordedRequest = { ...entry, status, ...(errorCode ? { errorCode } : {}) };
    this.requests.push(recorded);
    this.options.onRequest?.(recorded);
  }

  private send(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  }
}

function flatHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new FakeThinQError("BAD_REQUEST", "Request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new FakeThinQError("BAD_REQUEST", "Request body is not valid JSON");
  }
}
