# Deploying Amber with Dokku

One-time setup on the server:

```sh
dokku apps:create amber
dokku storage:ensure-directory amber
dokku storage:mount amber /var/lib/dokku/data/storage/amber:/data
dokku config:set amber AMBER_TOKEN=<generate a long random token>
# LLM: set one of these — provider is auto-detected from the key
# dokku config:set amber OPENAI_API_KEY=sk-...            # → gpt-4o-mini
# dokku config:set amber GEMINI_API_KEY=...               # → gemini-2.0-flash + YouTube summaries
# optional overrides: AMBER_LLM_PROVIDER, AMBER_LLM_MODEL, AMBER_LLM_BASE_URL (e.g. Ollama)
dokku domains:set amber amber.example.com
dokku letsencrypt:enable amber
```

From this repo:

```sh
git remote add dokku dokku@<server>:amber
git push dokku main
```

The SQLite database lives at `/data/amber.sqlite` inside the mount — deploys never touch it.
Backup = snapshot `/var/lib/dokku/data/storage/amber` on the host.
