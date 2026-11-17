/**
 * Run the fake ThinQ API as a standalone server:
 *
 *   npm run fake-thinq                   # http://127.0.0.1:8090, any token accepted
 *   FAKE_THINQ_PORT=9000 FAKE_THINQ_TOKEN=secret FAKE_THINQ_TIME_SCALE=60 npm run fake-thinq
 *
 * FAKE_THINQ_TIME_SCALE speeds up simulated time (60 = a dishwasher minute per second).
 *
 * The appliances are "used" on their own every FAKE_THINQ_ACTIVITY_SECONDS
 * (default 15; 0 turns it off): doors open and close, programmes start, ...
 * so a device watched in the app produces events without any scripting.
 * FAKE_THINQ_SEED makes that activity repeatable.
 */
import { FakeThinQ, MAX_ACTIVITY_INTERVAL_MS, MIN_ACTIVITY_INTERVAL_MS } from "./server.js";

const port = Number(process.env.FAKE_THINQ_PORT ?? 8090);
const host = process.env.FAKE_THINQ_HOST ?? "127.0.0.1";
const accessToken = process.env.FAKE_THINQ_TOKEN || undefined;
const timeScale = Number(process.env.FAKE_THINQ_TIME_SCALE ?? 1);

if (!Number.isFinite(timeScale) || timeScale <= 0) {
  console.error("FAKE_THINQ_TIME_SCALE must be a positive number");
  process.exit(1);
}

const activitySeconds = Number(process.env.FAKE_THINQ_ACTIVITY_SECONDS || 15);
if (
  !Number.isFinite(activitySeconds) ||
  (activitySeconds !== 0 && (activitySeconds * 1000 < MIN_ACTIVITY_INTERVAL_MS || activitySeconds * 1000 > MAX_ACTIVITY_INTERVAL_MS))
) {
  console.error(`FAKE_THINQ_ACTIVITY_SECONDS must be 0 (off) or between ${MIN_ACTIVITY_INTERVAL_MS / 1000} and ${MAX_ACTIVITY_INTERVAL_MS / 1000}`);
  process.exit(1);
}
const seed = process.env.FAKE_THINQ_SEED ? Number(process.env.FAKE_THINQ_SEED) : undefined;
if (seed !== undefined && !Number.isInteger(seed)) {
  console.error("FAKE_THINQ_SEED must be an integer");
  process.exit(1);
}

const fake = new FakeThinQ({
  accessToken,
  timeScale,
  onRequest: (r) =>
    console.log(`${new Date().toISOString()} ${r.method} ${r.path} -> ${r.status}${r.errorCode ? ` (code ${r.errorCode})` : ""}`),
  activity: activitySeconds > 0 ? { intervalMs: activitySeconds * 1000, seed } : undefined,
  onActivity: (a) => console.log(`${new Date().toISOString()} activity: ${a.alias}: ${a.action}`),
});

const url = await fake.listen(port, host);
console.log(`Fake ThinQ API listening on ${url}`);
for (const d of fake.devices) console.log(`  ${d.deviceInfo.deviceType.padEnd(22)} ${d.deviceInfo.alias.padEnd(16)} ${d.deviceId}`);
console.log(`Point the app at it with THINQ_API_BASE_URL=${url}` + (accessToken ? ` and THINQ_ACCESS_TOKEN=${accessToken}` : ""));
console.log(`Scenario endpoints: GET ${url}/__fake/requests, POST ${url}/__fake/reset, PATCH ${url}/__fake/devices/<id>, GET/POST/DELETE ${url}/__fake/faults, GET/PATCH ${url}/__fake/activity, POST ${url}/__fake/activity/step`);
console.log(
  activitySeconds > 0
    ? `Simulated appliance activity every ${activitySeconds} s (FAKE_THINQ_ACTIVITY_SECONDS=0 to turn off)`
    : "Simulated appliance activity is off",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await fake.close();
    process.exit(0);
  });
}
