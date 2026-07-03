# Amber — Build Checklist

Work top to bottom. Each task small enough to finish in one sitting. v1 = phases 0–6.

## Phase 0 — Scaffold
- [x] Repo init: Node/TypeScript, Hono, project layout (`server/`, `web/`, later `extension/`, `apps/`)
- [x] SQLite setup + migration runner; create schema from §3 **plus `jobs` table** (`id, type, payload, status, attempts, created_at, updated_at`)
- [x] Bearer token auth middleware (token from env/config)
- [x] Health endpoint, config loading (LLM keys, token, data dir)
- [ ] Dokku app created, persistent storage mount for SQLite, deploy hello-world end-to-end — *Dockerfile + DEPLOY.md ready; actual deploy needs your server (see DEPLOY.md)*

## Phase 1 — Core API
- [x] `POST /bookmarks` — insert immediately, enqueue enrichment job, dedup by canonical_url (return existing + `duplicate: true`)
- [x] `GET /bookmarks` — reverse-chron, filters `type`, `q` (title+gist+note LIKE), `read`, `before` cursor, `limit`
- [x] `GET /bookmarks/:id`, `PATCH` (note, title, is_read, topics), `DELETE`
- [x] `GET /bookmarks/:id/status` (for extension toast later)
- [x] Topics CRUD endpoints (`GET/POST /topics`, `DELETE /topics/:id` → reassign to `unsorted`)
- [x] Smoke test with `curl` — saving works before any UI exists

## Phase 2 — Enrichment pipeline
- [x] Job queue: p-queue executor over `jobs` table; **on startup re-enqueue all `pending`/`running` jobs**; jobs idempotent
- [x] URL normalization: resolve redirects, strip tracking params → `canonical_url`; post-normalize dedup check
- [x] Metadata fetch: title, og:image/title/description, favicon; desktop UA; failure → `fetch_status=dead`, bookmark kept
- [x] Text extraction with Defuddle → `content_text`; fallback to og:description when empty
- [x] YouTube branch: detect URL, oEmbed for channel/duration, Gemini call with video URL, `content_type=video` *(Gemini path untested — needs GEMINI_API_KEY; no-key fallback verified)*
- [x] LLM enrichment call: gist + summary + content_type (**no topics — vocabulary TBD**); JSON validation, one retry, then `enrich_status=failed`
- [x] Outbound rate limiting (fetches + LLM, few req/s)
- [x] Retry endpoint/mechanism for failed enrichment (`POST /bookmarks/:id/retry`)

## Phase 3 — Web UI (Svelte)
- [x] Svelte + Vite scaffold in `web/`, built static, served by Hono; token handling
- [x] Library view: reverse-chron card grid, infinite scroll, compact list toggle
- [x] Card: og_image with favicon-on-colored-tile fallback, domain, title, gist, type icon, relative date; click → detail, secondary click → original URL
- [x] Pending state: card renders instantly, gist shimmer until enriched (2s status polling); failed → retry glyph
- [x] Top bar: search field + content-type filter + topic chips (render once vocab exists); filters combine
- [x] Detail panel: summary, note editor, read-flag toggle, provenance line, delete, open original
- [x] Settings page: token connect + quick-save, LLM env reference, export downloads, import placeholder

## Phase 4 — Import / Export
- [x] Netscape bookmark HTML parser (Chrome/Firefox/Safari exports) + CSV/URL-list fallback
- [x] `POST /import` → throttled background batch through the standard pipeline; `GET /import/:job_id` progress
- [x] Preserve `ADD_DATE` as `saved_at`; `saved_from=import`; folder path stored as classification hint (unused until vocab)
- [x] Cross-source dedup at import (first seen wins, earliest date)
- [x] Import progress UI
- [x] `GET /export?format=json` (full fidelity) + `format=html` (Netscape)
- [ ] **Milestone: import real bookmark corpus** — v1 becomes daily-usable here *(your move: export bookmarks from Chrome, upload in Settings → Import; needs a real LLM key configured)*

## Phase 5 — Topic vocabulary  *(decision deferred — do after real corpus is in)*
- [ ] Decide vocabulary approach (candidate: AI-proposes from corpus, user approves — §3 sketch)
- [ ] Implement chosen flow + batch classification over library
- [ ] Add topics to ongoing enrichment call
- [ ] UI: topic chips on cards, topic filter row with counts, chip-picker editor in detail panel

## Phase 6 — Browser extension (WXT)
- [ ] WXT scaffold, settings (server URL, token, device name)
- [ ] Toolbar click + keyboard shortcut: save current tab; selected text → `note`
- [ ] Context menu "Save to Amber" on links; `referrer` = current page, `saved_from=context_menu`
- [ ] Toast: "Saved ✓" → swap to gist via status polling (~2s, give up at 10s)
- [ ] Chrome + Firefox builds tested; Safari via Xcode converter
- [ ] **Milestone: abandon Chrome bookmark bar — v1 done**

## Phase 7 — iOS / macOS apps
- [ ] SwiftUI multiplatform scaffold, URLSession API client, token settings
- [ ] Library view + detail (per §7 spec)
- [ ] iOS share extension (`saved_from=share_sheet`, source app → `source_detail`)
- [ ] macOS share extension

## v2 backlog (not now)
- FTS5 over content_text; page archival (Monolith), reader mode; yt-dlp archiving; "first saved {date}" dedup UX; related items via embeddings
