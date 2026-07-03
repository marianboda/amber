# Deploying Amber with Dokku

One-time setup on the server:

```sh
dokku apps:create amber
dokku storage:ensure-directory amber
dokku storage:mount amber /var/lib/dokku/data/storage/amber:/data
dokku config:set amber AMBER_TOKEN=<generate a long random token>
# LLM config (set when enrichment lands):
# dokku config:set amber AMBER_LLM_PROVIDER=openai AMBER_LLM_API_KEY=... AMBER_LLM_MODEL=gpt-4o-mini
# dokku config:set amber GEMINI_API_KEY=...
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
