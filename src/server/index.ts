import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { runMigrations } from "./db/index.js";
import { ThinQConfigError, ThinQError } from "./thinq/index.js";
import { authGate } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { deviceRoutes } from "./routes/devices.js";

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

// In production, serve the built SPA and fall back to index.html for client-side routes.
const webDir = resolve("dist/web");
if (existsSync(webDir)) {
  await app.register(fastifyStatic, { root: webDir });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html"),
  );
}

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
