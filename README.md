# Sparta

APP official-address search service with a protected admin review panel.

## Local run

```bash
node server.mjs
```

Open:

- `http://127.0.0.1:4173/`
- `http://127.0.0.1:4173/admin`

Local development defaults:

- admin username: `admin`
- admin password: `as758521`

These defaults are for local development only. In production, the service expects explicit `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

## Production data model

- Runtime storage uses SQLite at `DATA_DIR/sparta.sqlite`
- Legacy seed data is read from `data/apps.json` on first boot only, then migrated into SQLite
- Only records with `reviewStatus=approved` are returned by the public search API
- Admin sessions are stored in SQLite so login state survives service restarts
- Audit logs are stored in SQLite for login, import, create, update, delete, logout, and backup actions

## Deploy on Render

This repo includes `render.yaml` for Render Blueprint deploys.

The included Blueprint config sets:

- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `PORT=10000`
- `DATA_DIR=/var/data/sparta-data`
- a persistent disk mounted at `/var/data`
- `ADMIN_USERNAME` prompted during initial Blueprint creation
- `ADMIN_PASSWORD` prompted during initial Blueprint creation

## Required production configuration

Before sharing the deployed app publicly, make sure:

1. Set a real admin username in `ADMIN_USERNAME`
2. Set a strong admin password in `ADMIN_PASSWORD`
3. Keep `DATA_DIR` on the persistent disk mount so SQLite survives deploys and restarts
4. Confirm the service is running with `NODE_ENV=production`
5. Verify `/healthz` returns `authConfigured: true`
6. Export a backup after initial data migration and after any large batch import

## Built-in production safeguards

- Login attempts are rate-limited to reduce password brute-force abuse
- Mutating admin APIs require both a logged-in session cookie and a matching `X-CSRF-Token`
- Production `/healthz` only returns `{ ok: true }` instead of filesystem details
- Responses include baseline browser security headers such as CSP, `X-Frame-Options`, and `nosniff`
- Admin backup export includes both app records and audit logs in one JSON snapshot

## Render notes

- Render web services must bind to host `0.0.0.0` and use the port from the `PORT` environment variable
- Only filesystem changes under the disk mount path are persisted across deploys and restarts
- Render prompts for `sync: false` environment variables only during the initial Blueprint creation flow

## Deploy on Cloudflare Pages

This repo also includes a Cloudflare-compatible path:

1. Create a D1 database named `sparta`
2. Import `cloudflare/schema.sql`, then `cloudflare/seed.sql`
3. Create a Pages project from this GitHub repo
4. Bind the D1 database as `DB`
5. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in project variables

Cloudflare routes:

- Frontend: `/`
- Admin: `/admin`
- Health check: `/healthz`

## Data files

- `data/apps.json`: legacy seed data for first-time migration
- `DATA_DIR/sparta.sqlite`: active runtime database
