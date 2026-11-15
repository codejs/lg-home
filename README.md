# lg-home
A webapp for controlling LG home appliance

## Stack

Fastify + `thinqconnect` (server), React + Vite + TanStack Query (SPA), SQLite via Drizzle ORM + better-sqlite3.

## Setup

Requires Node 22.21.0 (see `.node-version`) and npm 10.9.4.

```sh
npm install
cp .env.example .env   # add your ThinQ Personal Access Token and country code
npm run dev            # API on :3000, SPA on http://localhost:5173
```

Production: `npm run build && npm start` (serves the API and SPA on :3000).

Schema changes: edit `src/server/db/schema.ts`, run `npm run db:generate`; migrations apply automatically on server start.
