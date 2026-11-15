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

Tests: `npm test` runs unit tests for the ThinQ client and an end-to-end test that
boots the server against a mock ThinQ API (no network or real account needed).
`npm run typecheck` checks server, web and test code.

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
