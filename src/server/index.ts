import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { runMigrations } from "./db/index.js";
import { ThinQError } from "./thinq.js";
import { deviceRoutes } from "./routes/devices.js";

runMigrations();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ThinQError) {
    return reply.code(502).send({ error: err.message, thinqStatus: err.status, thinqCode: err.code });
  }
  reply.send(err);
});

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
