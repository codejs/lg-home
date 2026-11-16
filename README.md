# lg-home
A webapp for controlling LG home appliance

## Stack

Fastify + a small built-in client for the LG ThinQ Connect REST API (server), React + Vite + TanStack Query (SPA), SQLite via Drizzle ORM + better-sqlite3.

## Setup

Requires Node 22.21.0 (see `.node-version`) and npm 10.9.4.

```sh
npm install
cp .env.example .env        # add your ThinQ Personal Access Token and country code
npm run add_user -- alice   # create a login (prompts for the password)
npm run dev                 # API on :3000, SPA on http://localhost:5173
```

Production: `npm run build && npm start` (serves the API and SPA on :3000).

Tests: `npm test` runs unit tests for the ThinQ client and the
[device events](#device-events) pipeline (state diff, settings, poller, event
streams), contract tests for the [fake ThinQ API](#fake-thinq-api), and
integration tests that boot the server against the fake (no network or real
account needed). `npm run typecheck` checks server, web and test code.

The project `.npmrc` sets `ignore-scripts=true`: better-sqlite3 ships prebuilt
binaries, but npm would otherwise run a no-op `node-gyp rebuild` that downloads
Node headers from nodejs.org and breaks installs without internet access. See
the comments in `.npmrc`; on a platform without a prebuild, run
`npm rebuild better-sqlite3 --ignore-scripts=false` once.

Schema changes: edit `src/server/db/schema.ts`, run `npm run db:generate`; migrations apply automatically on server start.

## Accounts and login

The SPA shows a login page until you sign in; every `/api/*` route except the
login endpoints requires a session. There is no self-service sign-up — an admin
provisions accounts from the command line:

```sh
npm run add_user -- <username>                      # prompts for the password (hidden)
npm run add_user -- <username> --password <secret>  # non-interactive
npm run add_user -- <username> --force              # change an existing password
echo "$SECRET" | npm run add_user -- <username>     # password from a pipe
```

After a build you can run the same tool without `tsx`:
`node --env-file-if-exists=.env dist/server/cli/add-user.js <username>`.

Users live in the `users` table; passwords are stored as scrypt digests, never
in plaintext. Signing in creates a row in `sessions` and sets an HttpOnly,
SameSite=Lax session cookie (7 days by default, `SESSION_TTL_HOURS` to change).
Changing a password with `--force` signs that user out everywhere. Put the app
behind HTTPS in production so the cookie is sent with the `Secure` flag
(auto-detected, or force it with `COOKIE_SECURE=true`).

## ThinQ API

`src/server/thinq/client.ts` calls the [ThinQ Connect](https://smartsolution.developer.lge.com/en/apiManage/thinq_connect)
REST API directly with `fetch` (no SDK): `GET /devices`, `GET /devices/{id}/state`,
`GET /devices/{id}/profile` and `POST /devices/{id}/control`. The server is picked
from `THINQ_COUNTRY_CODE` (`api-aic` Americas, `api-eic` Europe/Middle East/Africa,
`api-kic` Asia-Pacific). Optional overrides:

| Variable | Purpose |
| --- | --- |
| `THINQ_REGION` | Force `AIC`, `EIC` or `KIC` (e.g. for a country missing from the built-in table) |
| `THINQ_API_BASE_URL` | Use a different base URL, e.g. a mock server |
| `THINQ_API_KEY` | Override the public `x-api-key` published by LG |

Failures come back as `502` with `thinqStatus`/`thinqCode` from ThinQ, `504` when
ThinQ times out (15 s), and `503` when the token or country is not configured.

## Device events

Subscribe a device to get an event whenever its state changes. The server
polls the state of subscribed devices (`GET /devices/{id}/state`) and compares
each result with the last one it saw; a difference is stored as an event and
pushed to open event streams. Subscriptions belong to the ThinQ account, so
they are shared by all users. Control commands sent through the app are
recorded as events too.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/subscriptions` | Subscribed devices (last poll, last change, last error) and the poller status (`idle` / `paused`) |
| `PUT /api/devices/:id/subscription` | Subscribe (`201`; `200` if already subscribed). The first poll only records a baseline |
| `DELETE /api/devices/:id/subscription` | Unsubscribe (`204`); past events are kept |
| `GET /api/events?deviceId=&kind=&before=&limit=` | History, newest first. `kind` is `event` (state change) or `control`; page with `before` = smallest id seen; `limit` up to 200 |
| `GET /api/events/stream?deviceId=&kind=` | Live events as [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events); reconnecting clients send `Last-Event-ID` and get up to 500 missed events |

A state-change event looks like this; `report` is the changed part of the state
(shaped like ThinQ's own partial reports) and `changes` lists each value:

```json
{
  "id": 42, "deviceId": "7d3e…1a2b", "kind": "event", "createdAt": "2026-01-01T10:15:00.000Z",
  "payload": {
    "source": "poll",
    "report": { "runState": { "currentState": "END" } },
    "changes": [{ "path": "runState.currentState", "from": "RUNNING", "to": "END" }]
  }
}
```

Location-based resources are matched by `locationName`, e.g.
`temperature[FREEZER].targetTemperature`.

**Polling and the ThinQ call budget.** `EVENT_POLL_INTERVAL_SECONDS` (default 60)
sets the interval. Every poll is one ThinQ call per subscribed device, and
ThinQ limits calls per account, so the server:

- refuses to start with an interval below 15 s (allowed only when
  `THINQ_API_BASE_URL` points at this machine, i.e. the fake);
- polls devices one at a time and each at most once per interval, however
  often devices are subscribed, unsubscribed or re-subscribed;
- backs off a device whose poll fails for device reasons (offline, removed),
  doubling up to 15 minutes, and shows the error on its subscription;
- pauses all polling on anything else (rate limit `1306`, bad token, ThinQ
  down, unknown errors), doubling up to 30 minutes;
- ignores states that are not a JSON object, nested deeper than 32 levels or
  larger than 256 KB.

Polling never sends commands. With no subscriptions it makes no ThinQ calls.

**Retention.** State-change events older than `EVENT_RETENTION_DAYS` (default 30)
are deleted at startup and hourly. Control records are kept as an audit trail.

**Streams and sessions.** A stream is tied to the session that opened it: the
session is re-checked before every event and every 25 s, so logging out (which
closes the session's streams at once), a password change or session expiry
ends it. Each user can have 5 streams open (100 in total); clients that stop
reading are disconnected. Behind a reverse proxy, make sure responses are not
buffered (the server sends `X-Accel-Buffering: no` for nginx).

## Fake ThinQ API

`test/fake-thinq/` is a stand-in for the ThinQ Connect API, for integration
tests and for working on the app without an LG account or real appliances. It
speaks the same protocol as the real service (paths, required headers, response
and error envelopes) and serves two devices:

| Device | Type | ID | Notes |
| --- | --- | --- | --- |
| Kitchen Fridge | `DEVICE_REFRIGERATOR` | `b2f6c91d…7c6d` | Fridge (1–7 °C) and freezer (−23 to −15 °C) set points, express mode, power save, fresh air filter; controls locked in sabbath mode |
| Dishwasher | `DEVICE_DISH_WASHER` | `7d3e9a1c…1a2b` | `START` / `STOP` / `POWER_OFF`; starting needs remote start enabled on the appliance (off by default) and a closed door; programmes count down and finish as time passes |

Control commands are checked against each device's profile: unknown or
read-only properties, out-of-range values and wrong types are rejected with
ThinQ error codes, and accepted commands change the state. The fake also
checks the bearer token, `x-api-key`, the required `x-*` headers and that
every `x-message-id` is well-formed and unique.

Run the app against it:

```sh
npm run add_user:fake -- alice   # login for the fake setup (separate database)
npm run dev:fake                 # fake ThinQ on :8090 + API on :3000 + SPA on :5173
```

`dev:fake` loads `test/fake-thinq/fake.env` after `.env`, which points the
server at the fake and uses `data/lg-home-fake.db` so fake devices never mix
with real ones. To run only the fake: `npm run fake-thinq` (options:
`FAKE_THINQ_PORT`, `FAKE_THINQ_HOST`, `FAKE_THINQ_TOKEN` to require one exact
token, `FAKE_THINQ_TIME_SCALE=60` to run a dishwasher minute per second).

Set up scenarios with the fake-only endpoints (no auth, bind to localhost only):

```sh
curl localhost:8090/__fake/requests                     # recorded ThinQ calls
curl -X POST localhost:8090/__fake/reset                # back to initial state (also clears faults)
# press "remote start" on the dishwasher
curl -X PATCH localhost:8090/__fake/devices/7d3e9a1c5b2f4e8a9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b \
  -H 'Content-Type: application/json' -d '{"state":{"remoteControlEnable":{"remoteControlEnabled":true}}}'
# take the fridge offline
curl -X PATCH localhost:8090/__fake/devices/b2f6c91d0a4e4f5c9e8d7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d \
  -H 'Content-Type: application/json' -d '{"online":false}'
# make ThinQ rate-limit the account until cleared (error: any key of ERRORS in protocol.ts;
# optional "method", exact "path", "times": n or "always", default 1)
curl -X POST localhost:8090/__fake/faults \
  -H 'Content-Type: application/json' -d '{"error":"EXCEEDED_API_CALLS","times":"always"}'
curl localhost:8090/__fake/faults                       # faults not used up yet
curl -X DELETE localhost:8090/__fake/faults             # clear them
```

Patching state, the dishwasher's programme running out and control commands
all change the state the server polls, so they show up as device events when
the device is subscribed (`dev:fake` polls every 5 s). Faults are applied
after the header checks, so requests still have to be valid.

In tests, use it in-process with a controllable clock:

```ts
let clock = Date.now();
const fake = new FakeThinQ({ accessToken: "pat-test", now: () => clock });
const url = await fake.listen();         // pass as THINQ_API_BASE_URL
fake.device(DISHWASHER_ID)!.patchState({ remoteControlEnable: { remoteControlEnabled: true } });
clock += 90 * 60_000;                     // fast-forward the running programme
fake.injectFault({ error: "EXCEEDED_API_CALLS", path: /\/state$/, times: 3 });
fake.requests;                            // what the app sent
```

`test/helpers/app-server.ts` starts the real server as a child process against
the fake and has a small Server-Sent Events client, for integration tests like
`test/events.e2e.test.ts`.

The device data is modelled on the ThinQ Connect docs but is not an exact copy
of any real model. Error codes come from the official list in LG's
`thinqconnect` SDK, copied into `THINQ_ERROR_CODES` in
`test/fake-thinq/protocol.ts`; the fake's `ERRORS` must use those names and
codes (enforced by the type checker and a test), while the HTTP statuses are
our best model of the live service. Keep both files in line with the live API
if they drift.
