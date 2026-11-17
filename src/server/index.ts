import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig, type ServerConfig } from "./config.js";
import { closeDatabase, openDatabase, runMigrations } from "./db/index.js";
import { startRetention } from "./events/retention.js";

// Check every setting before doing anything (e.g. polling ThinQ too often).
let config: ServerConfig;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}

openDatabase(config.databasePath);
runMigrations();

const app = await buildApp({
  logger: { level: config.logLevel },
  webDir: resolve("dist/web"),
  pollIntervalMs: config.events.pollIntervalMs,
  sessionTtlMs: config.sessionTtlMs,
  cookieSecure: config.cookieSecure,
});

const stopRetention = startRetention(config.events.retentionDays, app.log);
app.addHook("onClose", async () => stopRetention());

await app.listen({ port: config.port, host: config.host });
app.log.info({ pollIntervalMs: config.events.pollIntervalMs, retentionDays: config.events.retentionDays }, "device event polling started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    app
      .close()
      .then(() => {
        closeDatabase();
        process.exit(0);
      })
      .catch((err) => {
        app.log.error({ err }, "shutdown failed");
        process.exit(1);
      });
  });
}
