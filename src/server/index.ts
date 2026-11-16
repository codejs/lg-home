import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { runMigrations } from "./db/index.js";

runMigrations();

const app = await buildApp({ webDir: resolve("dist/web") });
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
