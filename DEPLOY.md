# Deploying Amber with Dokku

One-time setup on the server:

```sh
dokku apps:create amber
# Postgres for metadata (bookmarks/topics/jobs). Either a dokku-postgres
# service (`dokku postgres:create amber-db && dokku postgres:link amber-db amber`,
# which sets DATABASE_URL) or an existing Postgres — set DATABASE_URL yourself.
# The disk mount below still holds archives, cached assets, backups, and trash.
# ensure-directory chowns to uid 32767 (herokuish) — the Dockerfile's runtime
# user matches, so no root chown is needed on the host.
dokku storage:ensure-directory amber
dokku storage:mount amber /var/lib/dokku/data/storage/amber:/data
# The container reads DATA_DIR or AMBER_DATA_DIR for the mount:
dokku config:set amber AMBER_DATA_DIR=/data
dokku config:set amber AMBER_TOKEN=<generate a long random token>
# Behind Dokku's nginx the client IP arrives in X-Forwarded-For; without this
# the auth brute-force limiter keys on nginx's IP and can lock everyone out.
dokku config:set amber AMBER_TRUST_PROXY=1
# LLM: set one of these — provider is auto-detected from the key
# dokku config:set amber OPENAI_API_KEY=sk-...            # → gpt-4o-mini
# dokku config:set amber GEMINI_API_KEY=...               # → gemini-2.0-flash + YouTube summaries
# optional overrides: AMBER_LLM_PROVIDER, AMBER_LLM_MODEL, AMBER_LLM_BASE_URL (e.g. Ollama)
# If the Postgres is another app on a private Docker network (not a
# dokku-postgres service), attach amber to that network AT CREATE TIME so the
# boot-time migration can resolve the DB host:
#   dokku network:set amber initial-network <that-network>
# Dockerfile apps may not get an automatic proxy port map — ensure nginx routes
# :80 to the container's :3000:
dokku ports:set amber http:80:3000
dokku domains:set amber amber.example.com
dokku letsencrypt:set amber email you@example.com
dokku letsencrypt:enable amber   # needs :80 routing working first (ports above)
# Archive uploads from the extension can be large (up to 300MB) and imports up
# to 100MB; nginx's default limit is 1MB and would reject them:
dokku nginx:set amber client-max-body-size 300m
dokku proxy:build-config amber
```

From this repo:

```sh
git remote add dokku dokku@<server>:amber
git push dokku master
```

## Backup

Two layers of state: the **Postgres database** (metadata) and the **disk mount**
(`/data/archives`, `/data/assets`).

- **Primary: `GET /api/export?format=zip`** — a full backup of metadata *and*
  archives in one file, and it's also the restore format:
  `POST /api/import` (Content-Type: `application/zip`) rebuilds a fresh instance
  from it. This is the recommended backup because it's the only one that
  captures the archived pages too.
- **Postgres:** back the database up at the Postgres host —
  `dokku postgres:export <service> > amber-$(date +%F).dump` for a
  dokku-postgres service, or `pg_dump` against DATABASE_URL. The app also writes
  a daily `pg_dump` snapshot to `/data/backups/` when a matching `pg_dump`
  client is on the container's PATH (best-effort; off by default in the slim
  image).
- **Disk mount:** sync `/data/archives` and `/data/assets` off the host.
