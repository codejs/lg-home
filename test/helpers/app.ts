import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { buildApp, type AppOptions } from "../../src/server/app.js";
import { provisionUser } from "../../src/server/users.js";
import { StubThinQ } from "./stub-thinq.js";

export interface TestApp {
  app: FastifyInstance;
  thinq: StubThinQ;
}

/** The real app (auth gate, routes, error handler) with a stub ThinQ client and no logging. */
export async function buildTestApp(options: AppOptions = {}): Promise<TestApp> {
  const thinq = new StubThinQ();
  const app = await buildApp({ logger: false, thinq: () => thinq, ...options });
  await app.ready();
  return { app, thinq };
}

export async function createUser(username = "alice", password = "secret123"): Promise<void> {
  await provisionUser({ username, password });
}

/** Log in and return the `name=value` cookie pair to send back. */
export async function login(app: FastifyInstance, username = "alice", password = "secret123"): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return cookiePair(res);
}

export function cookiePair(res: LightMyRequestResponse): string {
  const header = res.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("no Set-Cookie header");
  return value.split(";")[0];
}

/** inject() with a session cookie. */
export function as(app: FastifyInstance, cookie: string, options: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject({ ...options, headers: { ...options.headers, cookie } });
}
