# Amber

A permanent, searchable personal bookmark library. Save a link from any browser or device with zero friction; the server labels, summarizes, previews, and archives it automatically. Retrieval is scroll-recent → filter → search. Named for permanence: what you save is preserved intact, like an insect in amber.

Single primary user. Reference library, not a reading queue — nothing decays, expires, or nags.

See [`amber-design-doc.md`](amber-design-doc.md) for the full product/architecture spec and [`TODO.md`](TODO.md) for build status.

## Repository layout

```
server/       Hono + TypeScript API, SQLite (FTS5), in-process job queue — source of truth
  src/        routes/, pipeline/ (fetch, extract, enrich, archive, assets), queue, auth, db
  migrations/ 001..004, applied automatically on boot
  test/       vitest (46 tests): unit + API + archive + queue recovery
web/          Svelte 5 + Vite web UI, built static and served by the server
extension/    WXT browser extension (Chrome MV3 + Firefox MV2), single-file page capture
Dockerfile    two-stage build (web then server) for Dokku deploy
DEPLOY.md      Dokku setup on the existing server
```

## Architecture in one paragraph

The **server is the source of truth**; all clients are thin (POST a save, GET lists/search). Every save inserts a bookmark immediately and enqueues an enrichment job — the API returns at once. A DB-backed job queue (`jobs` table + in-process poller) fetches the page, extracts text with Defuddle, calls one cheap LLM for gist/summary/type, caches the thumbnail + favicon locally, and stores a page archive. SQLite with FTS5 backs full-text search. Auth is a single bearer token. Provider is auto-detected from `OPENAI_API_KEY` / `GEMINI_API_KEY`; with no key it runs **metadata-only** (fetch + extract + search, no gist/summary).

## Quick start (local, no LLM needed)

```sh
cd server && npm install
AMBER_TOKEN=devtoken npm run dev          # http://localhost:3000
```

Open `http://localhost:3000`, go to **Settings**, paste the token, Connect. Save links via Quick save, the bookmarklet (Settings), or `curl`:

```sh
curl -X POST localhost:3000/api/bookmarks \
  -H "Authorization: Bearer devtoken" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```

To enable AI gist/summary, add an LLM key (see below) before starting.

### Web UI development (hot reload)

```sh
cd web && npm install && npm run dev       # proxies /api to :3000
```

The server serves the built `web/dist` in production; run the server too for the API.

### Extension

```sh
cd extension && npm install && npm run build   # → extension/.output/chrome-mv3
```

Load unpacked from `extension/.output/chrome-mv3` (Chrome `chrome://extensions`, Developer mode). Firefox: `npm run build:firefox`, load `extension/.output/firefox-mv2/manifest.json` from `about:debugging`. Configure server URL + token + device name in the extension options. Safari: `xcrun safari-web-extension-converter extension/.output/chrome-mv3` (needs Xcode).

## Configuration (server env vars)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AMBER_TOKEN` | **yes** | — | bearer token for all `/api` access |
| `AMBER_DATA_DIR` | no | `./data` | SQLite + archives + cached assets live here |
| `PORT` | no | `3000` | listen port |
| `OPENAI_API_KEY` | no | — | selects OpenAI provider (gpt-4o-mini) |
| `GEMINI_API_KEY` | no | — | selects Gemini provider (gemini-2.0-flash) **and** enables YouTube video summaries |
| `AMBER_LLM_PROVIDER` | no | auto | override: `openai` \| `gemini` \| `ollama` \| `none` |
| `AMBER_LLM_MODEL` | no | per-provider | override model name |
| `AMBER_LLM_BASE_URL` | no | — | OpenAI-compatible endpoint (e.g. local Ollama) |
| `AMBER_DEVICE` | no | hostname | device name recorded in provenance |
| `AMBER_ALLOW_PRIVATE` | no | off | `1` disables the SSRF guard — **dev only**, lets you save `localhost` |
| `AMBER_TRUST_PROXY` | no | off | `1` trusts `X-Forwarded-For` for rate limiting — set only behind a proxy (e.g. Dokku's nginx) |

Provider auto-detection order: `OPENAI_API_KEY` → `GEMINI_API_KEY` → `AMBER_LLM_BASE_URL` (Ollama) → `none` (metadata-only).

## Commands

```sh
# server/
npm run dev          # tsx watch
npm run build        # tsc → dist/
npm start            # node dist/index.js
npm test             # vitest (46 tests)
npm run typecheck    # tsc --noEmit

# web/
npm run dev / build / check   # check = svelte-check + tsc

# extension/
npm run build / build:firefox / dev / zip
```

## Deploy

Dokku on the existing server; `git push dokku master` deploys. SQLite + archives live on a persistent storage mount so deploys never touch data. See [`DEPLOY.md`](DEPLOY.md).

## Status

v1 (server, web UI, import/export, extension) is built and tested. Full-text search, page archival, reader mode, and a zip backup were pulled forward from v2. Four independent code-review passes have been applied. Open items and the roadmap are in [`TODO.md`](TODO.md); the one deliberately-deferred design decision is the **topic vocabulary** approach (§3 of the design doc). See [`docs/STATUS.md`](docs/STATUS.md) for the current handover state.
