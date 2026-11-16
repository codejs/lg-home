import { existsSync } from "node:fs";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
  type RouteOptions,
} from "fastify";
import fastifyStatic from "@fastify/static";
import { authGate } from "./auth.js";
import type { LoginThrottle } from "./login-throttle.js";
import { authRoutes } from "./routes/auth.js";
import { deviceRoutes, type ThinQDeviceApi } from "./routes/devices.js";
import { ThinQConfigError, ThinQError } from "./thinq/index.js";

export interface AppOptions {
  logger?: FastifyServerOptions["logger"];
  /** ThinQ client factory (defaults to the env-configured shared client). */
  thinq?: () => ThinQDeviceApi;
  throttle?: LoginThrottle;
  /** Built SPA to serve; omitted or missing directory = API only. */
  webDir?: string;
  /** Observe every registered route (used by tests to audit the auth gate). */
  onRoute?: (route: RouteOptions) => void;
}

/** Build the HTTP app without listening, so tests can use `app.inject()`. */
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? { level: process.env.LOG_LEVEL ?? "info" } });
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

  await app.register(authRoutes, { throttle: options.throttle });
  await app.register(deviceRoutes, { thinq: options.thinq });

  // Serve the built SPA and fall back to index.html for client-side routes.
  if (options.webDir && existsSync(options.webDir)) {
    await app.register(fastifyStatic, { root: options.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html"),
    );
  }

  return app;
}
