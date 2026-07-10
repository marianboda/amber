# Deploying Amber with Dokku

One-time setup on the server:

```sh
dokku apps:create amber
dokku storage:ensure-directory amber
# The container runs as the unprivileged `node` user (uid 1000) — give it the mount:
chown -R 1000:1000 /var/lib/dokku/data/storage/amber
dokku storage:mount amber /var/lib/dokku/data/storage/amber:/data
dokku config:set amber AMBER_TOKEN=<generate a long random token>
# Behind Dokku's nginx the client IP arrives in X-Forwarded-For; without this
# the auth brute-force limiter keys on nginx's IP and can lock everyone out.
dokku config:set amber AMBER_TRUST_PROXY=1
# LLM: set one of these — provider is auto-detected from the key
# dokku config:set amber OPENAI_API_KEY=sk-...            # → gpt-4o-mini
# dokku config:set amber GEMINI_API_KEY=...               # → gemini-2.0-flash + YouTube summaries
# optional overrides: AMBER_LLM_PROVIDER, AMBER_LLM_MODEL, AMBER_LLM_BASE_URL (e.g. Ollama)
dokku domains:set amber amber.example.com
dokku letsencrypt:enable amber
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

The SQLite database lives at `/data/amber.sqlite` inside the mount — deploys never touch it.

Do **not** back up by copying `amber.sqlite` while the server is running: the
database runs in WAL mode, and a raw copy that misses the `-wal` file can be
inconsistent. Safe options:

- `sqlite3 /var/lib/dokku/data/storage/amber/amber.sqlite ".backup /tmp/amber-backup.sqlite"`,
  then sync that snapshot plus `/data/archives` and `/data/assets` off the host.
- Full export including archives: `GET /api/export?format=zip`.
