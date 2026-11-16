import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { runMigrations } from "./db/index.js";
import { ThinQConfigError, ThinQError, thinq } from "./thinq/index.js";
import { authGate } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { deviceRoutes } from "./routes/devices.js";
import { eventRoutes } from "./routes/events.js";
import { eventConfigFromEnv } from "./events/config.js";
import { EventPoller } from "./events/poller.js";
import { startRetention } from "./events/retention.js";
import { closeAllStreams } from "./events/streams.js";

// Fail fast on invalid event settings rather than polling ThinQ too often.
const eventConfig = eventConfigFromEnv();

runMigrations();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

app.setErrorHandler((err, req, reply) => {
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
  reply.send(err);
});

// Everything under /api/ needs a session, except the login endpoints.
// Registered before the routes so it runs for all of them.
app.decorateRequest("user", undefined);
app.addHook("onRequest", authGate);

await app.register(authRoutes);
await app.register(deviceRoutes);

const poller = new EventPoller({ intervalMs: eventConfig.pollIntervalMs, client: thinq, log: app.log });
await app.register(eventRoutes, { poller });

// In production, serve the built SPA and fall back to index.html for client-side routes.
const webDir = resolve("dist/web");
if (existsSync(webDir)) {
  await app.register(fastifyStatic, { root: webDir });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html"),
  );
}

const stopRetention = startRetention(eventConfig.retentionDays, app.log);

// Open event streams never finish on their own: end them before closing.
app.addHook("preClose", async () => closeAllStreams());
app.addHook("onClose", async () => {
  stopRetention();
  await poller.stop();
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
poller.start();
app.log.info({ pollIntervalMs: eventConfig.pollIntervalMs, retentionDays: eventConfig.retentionDays }, "device event polling started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    app
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error({ err }, "shutdown failed");
        process.exit(1);
      });
  });
}
