import { existsSync } from "node:fs";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
  type RouteOptions,
} from "fastify";
import fastifyStatic from "@fastify/static";
import { authGate } from "./auth.js";
import { EventBus } from "./events/bus.js";
import { DEFAULT_POLL_INTERVAL_SECONDS } from "./events/config.js";
import { EventPoller } from "./events/poller.js";
import { StreamRegistry } from "./events/streams.js";
import type { LoginThrottle } from "./login-throttle.js";
import { authRoutes } from "./routes/auth.js";
import { deviceRoutes, type ThinQDeviceApi } from "./routes/devices.js";
import { eventRoutes } from "./routes/events.js";
import { ThinQConfigError, ThinQError, thinq as defaultThinQ } from "./thinq/index.js";

/**
 * Everything the app needs from outside. The server passes its checked
 * configuration (see config.ts); tests pass what they need. The app reads no
 * environment variables itself.
 */
export interface AppOptions {
  /** Default: info-level logging. */
  logger?: FastifyServerOptions["logger"];
  /** ThinQ client factory (defaults to the env-configured shared client). */
  thinq?: () => ThinQDeviceApi;
  throttle?: LoginThrottle;
  /** How long a login stays valid (default 7 days). */
  sessionTtlMs?: number;
  /** Force the session cookie's Secure flag on or off; null/omitted detects HTTPS per request. */
  cookieSecure?: boolean | null;
  /**
   * How often subscribed devices are polled for device events (default: the
   * EVENT_POLL_INTERVAL_SECONDS default). Polling starts when the server
   * listens, so `app.inject()` tests never call ThinQ.
   */
  pollIntervalMs?: number;
  /** Built SPA to serve; omitted or missing directory = API only. */
  webDir?: string;
  /** Observe every registered route (used by tests to audit the auth gate). */
  onRoute?: (route: RouteOptions) => void;
}

/**
 * Build the HTTP app without listening, so tests can use `app.inject()`. Each
 * app has its own event bus and event streams: apps in one process don't see
 * each other's live events, and closing one ends only its own streams. (The
 * database is shared: open it with openDatabase() first.)
 */
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? { level: "info" } });
  if (options.onRoute) app.addHook("onRoute", options.onRoute);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ThinQError) {
      req.log.warn({ reason: err.reason, thinqStatus: err.status, thinqCode: err.code }, err.message);
      // Upstream trouble: 504 when ThinQ timed out, 502 for everything else.
      return reply
        .code(err.reason === "timeout" ? 504 : 502)
        .send({ error: err.message, thinqStatus: err.status, thinqCode: err.code });
    }
    if (err instanceof ThinQConfigError) {
      req.log.error(err.message);
      return reply.code(503).send({ error: err.message });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      // Log the details, but never send internals (SQL, stack, paths) to the client.
      req.log.error({ err }, "unhandled error");
      return reply.code(500).send({ error: "Internal Server Error" });
    }
    // 4xx from Fastify itself (validation, unsupported media type, ...) are safe to show.
    return reply.send(err);
  });

  // Everything under /api/ needs a session, except the login endpoints.
  // Registered before the routes so it runs for all of them.
  app.decorateRequest("user", undefined);
  app.addHook("onRequest", authGate);

  const bus = new EventBus();
  const streams = new StreamRegistry(bus);

  await app.register(authRoutes, {
    throttle: options.throttle,
    sessionTtlMs: options.sessionTtlMs,
    cookieSecure: options.cookieSecure,
    streams,
  });
  await app.register(deviceRoutes, { thinq: options.thinq, bus });

  const poller = new EventPoller({
    intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_SECONDS * 1000,
    client: options.thinq ?? defaultThinQ,
    log: app.log,
    bus,
  });
  await app.register(eventRoutes, { poller, streams });
  app.addHook("onListen", async () => poller.start());
  // Open event streams never finish on their own: end this app's before closing.
  app.addHook("preClose", async () => streams.closeAll());
  app.addHook("onClose", async () => poller.stop());

  // Serve the built SPA and fall back to index.html for client-side routes.
  if (options.webDir && existsSync(options.webDir)) {
    await app.register(fastifyStatic, { root: options.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html"),
    );
  }

  return app;
}
