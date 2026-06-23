# Sparta

APP official address search prototype with a local admin panel.

## Local run

```bash
node server.mjs
```

Open:

- `http://127.0.0.1:4173/`
- `http://127.0.0.1:4173/admin.html`

## Deploy on Render

This repo includes `render.yaml` for Render Blueprint deploys.

Important:

- The app needs to bind to `0.0.0.0` and use `PORT` in production.
- Search data is stored in `apps.json`.
- To preserve admin changes across deploys and restarts, `DATA_DIR` should point to a persistent disk mount.

The included blueprint sets:

- `HOST=0.0.0.0`
- `PORT=10000`
- `DATA_DIR=/var/data/sparta-data`
- a persistent disk mounted at `/var/data`

## Data

Default seed data lives in `data/apps.json`.
