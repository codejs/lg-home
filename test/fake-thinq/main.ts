/**
 * Run the fake ThinQ API as a standalone server:
 *
 *   npm run fake-thinq                   # http://127.0.0.1:8090, any token accepted
 *   FAKE_THINQ_PORT=9000 FAKE_THINQ_TOKEN=secret FAKE_THINQ_TIME_SCALE=60 npm run fake-thinq
 *
 * FAKE_THINQ_TIME_SCALE speeds up simulated time (60 = a dishwasher minute per second).
 */
import { FakeThinQ } from "./server.js";

const port = Number(process.env.FAKE_THINQ_PORT ?? 8090);
const host = process.env.FAKE_THINQ_HOST ?? "127.0.0.1";
const accessToken = process.env.FAKE_THINQ_TOKEN || undefined;
const timeScale = Number(process.env.FAKE_THINQ_TIME_SCALE ?? 1);

if (!Number.isFinite(timeScale) || timeScale <= 0) {
  console.error("FAKE_THINQ_TIME_SCALE must be a positive number");
  process.exit(1);
}

const fake = new FakeThinQ({
  accessToken,
  timeScale,
  onRequest: (r) =>
    console.log(`${new Date().toISOString()} ${r.method} ${r.path} -> ${r.status}${r.errorCode ? ` (code ${r.errorCode})` : ""}`),
});

const url = await fake.listen(port, host);
console.log(`Fake ThinQ API listening on ${url}`);
for (const d of fake.devices) console.log(`  ${d.deviceInfo.deviceType.padEnd(22)} ${d.deviceInfo.alias.padEnd(16)} ${d.deviceId}`);
console.log(`Point the app at it with THINQ_API_BASE_URL=${url}` + (accessToken ? ` and THINQ_ACCESS_TOKEN=${accessToken}` : ""));
console.log(`Scenario endpoints: GET ${url}/__fake/requests, POST ${url}/__fake/reset, PATCH ${url}/__fake/devices/<id>`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await fake.close();
    process.exit(0);
  });
}
