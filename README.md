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

## Tests

```sh
npm test                  # everything (~30 s)
npm run test:unit         # fast, in-process: no ports, no subprocesses
npm run test:integration  # real server / CLI processes against the fake ThinQ API
npm run typecheck         # server, web and test code
```

Tests use Node's built-in runner (`node:test`) via tsx; React components are
tested with Testing Library on [happy-dom](https://github.com/capricorn86/happy-dom).

| Directory | What it covers |
| --- | --- |
| `test/unit/server/` | Password hashing and verification, sessions, cookies, the login rate limiter, user provisioning, CLI argument parsing, ThinQ client and config, DB constraints, and every HTTP route via `app.inject()` (auth gate audit, error mapping, static hosting) |
| `test/unit/web/` | The browser API client, device-state formatting (`deviceFormat`), `DeviceCard`, `LoginPage`, the `App` auth gate and `DevicesPage` |
| `test/integration/` | The server against the [fake ThinQ API](#fake-thinq-api), the fake's own contract, and the `add_user` CLI as a real process |

Security-relevant cases are tested explicitly: an audit that every `/api` route
except login/logout/me rejects anonymous and forged sessions, session rotation
on login, hashed session tokens, cookie flags, username enumeration, brute-force
throttling (including whitespace/case bypass attempts), tampered password
digests, injection-style input, path traversal, XSS in rendered data and error
messages, and that 500 responses don't leak internals.

Helpers: `test/helpers/test-db.ts` gives each test file its own SQLite file
(import it first), `app.ts` builds the real app with a stub ThinQ client
(`stub-thinq.ts`), `fetch.ts` routes `fetch()` in web tests, and `dom.ts`
installs the browser globals. In web tests, use `assertAbsent`/`assertSameNode`
from `dom.ts` rather than passing DOM nodes to `node:assert`: when such an
assertion fails, Node tries to print the happy-dom node and the run hangs
instead of reporting the failure.

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

## Device cards

Each device gets a card that loads its live state from ThinQ and refreshes every
minute (or on demand via **Refresh**). Every refresh is also stored as a history
snapshot. A card shows:

- a **status pill** (Running, Ready, Finished, Off, Offline, …) when the device
  reports a run state or power state;
- the **key figures** in large type: compartment temperatures, time left with an
  estimated end time and a progress bar, the selected programme or mode;
- **alerts** that need attention (door open, rinse aid low, filter to replace,
  appliance error) and chips for the **modes that are switched on**;
- **All details**: every property the device reports, labelled and formatted
  (units, durations, on/off), with the raw JSON underneath for debugging.

The interpretation lives in `src/web/deviceFormat.ts`. It recognises property
names ThinQ uses across appliances (`runState`, `timer`, `temperature`,
`doorStatus`, `*JobMode`, …) rather than hard-coding device types, so appliances
it has never seen still get a readable card. Add curated labels there
(`KEY_LABELS`, `ENUM_LABELS`, `TYPE_LABELS`) to polish a specific device.

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
ThinQ-style error codes, and accepted commands change the state. The fake also
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
curl -X POST localhost:8090/__fake/reset                # back to initial state
# press "remote start" on the dishwasher
curl -X PATCH localhost:8090/__fake/devices/7d3e9a1c5b2f4e8a9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b \
  -H 'Content-Type: application/json' -d '{"state":{"remoteControlEnable":{"remoteControlEnabled":true}}}'
# take the fridge offline
curl -X PATCH localhost:8090/__fake/devices/b2f6c91d0a4e4f5c9e8d7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d \
  -H 'Content-Type: application/json' -d '{"online":false}'
```

In tests, use it in-process with a controllable clock:

```ts
let clock = Date.now();
const fake = new FakeThinQ({ accessToken: "pat-test", now: () => clock });
const url = await fake.listen();         // pass as THINQ_API_BASE_URL
fake.device(DISHWASHER_ID)!.patchState({ remoteControlEnable: { remoteControlEnabled: true } });
clock += 90 * 60_000;                     // fast-forward the running programme
fake.requests;                            // what the app sent
```

The device data and error codes are modelled on the ThinQ Connect docs but are
not an exact copy of any real model; keep `test/fake-thinq/protocol.ts`
(`ERRORS`) and `devices.ts` in line with the live API if they drift.
