# Enhancement plan

Full-repo review (2026-07-05, three parallel reviewers over server, web+extension, docs) produced the findings below, organized into work batches. Each item has scope, file references, effort (S/M/L), and acceptance criteria. Batches are ordered by value; within a batch, items are independent unless noted.

Status legend: `[ ]` not started · `[x]` done.

---

## Batch 1 — Import survival kit

The next milestone is importing a real corpus (~20k bookmarks). These items keep the server responsive, the cost bounded, and the process observable during that import. Do these before importing.

### 1.1 Fix infinite enrich-rescue loop `[ ]` — S

A page that consistently exceeds the 180s job budget loops forever: timeout leaves `enrich_status='pending'` (`server/src/pipeline/enrich.ts:56-61`), the job goes `failed` after `MAX_ATTEMPTS=2`, and `maintenance()` (`server/src/index.ts:29-53`) only checks for `pending/running` jobs, so it re-enqueues the bookmark every 60s — with a real LLM call each cycle.

- Make `maintenance()` skip bookmarks that have a `failed` enrich job newer than some window (e.g. 24h), or add a rescue counter and stamp `enrich_status='failed'` after N rescues.
- Regression test: simulate a timed-out job, run `maintenance()` twice, assert single rescue then stop.

**Done when:** a permanently-timing-out bookmark reaches a terminal state and stops consuming LLM calls.

### 1.2 Import scale cliff `[ ]` — M

Three compounding problems that will hurt at 20k–50k items:

1. **O(n²) progress rewrites** — `runImport` re-serializes the entire remaining items array into `jobs.payload` every 50 rows (`server/src/import/run.ts:78-82`), synchronously. Store a cursor/progress in a separate column (or side table for pending items) instead of rewriting the payload.
2. **Per-item WAL commits** — each item is 2 separate writes (insert + enqueue). Wrap chunks in `db.transaction`.
3. **O(pending × jobs) orphan sweep** — `j.payload LIKE '%'||b.id||'%'` (`server/src/index.ts:38-41`) is a full-scan correlated subquery, run every 60s. Add a real `bookmark_id` column on `jobs` (migration) with an index, populate on enqueue, and join on it.

**Done when:** a 50k-item import file runs without multi-second event-loop stalls (verify with a generated fixture), and the orphan sweep is indexed.

### 1.3 List endpoint payload + N+1 + indexes `[ ]` — S

- `GET /bookmarks` does `SELECT b.*` including `content_text` (up to hundreds of KB per row) — `server/src/routes/bookmarks.ts:150`. Use an explicit card-level column list; full row stays on `GET /:id`.
- `topicsForBookmark` runs per row in list and export (`bookmarks.ts:154`, `server/src/routes/export.ts:15`). Replace with one `json_group_array` join or a batched `IN (...)` query.
- Migration 005: indexes on `bookmarks(enrich_status)`, `bookmarks(import_batch)`, `bookmarks(content_type)`, `jobs(status, created_at)` (plus `jobs(bookmark_id)` from 1.2).

**Done when:** list response for 200 rows is a few hundred KB max and issues a constant number of queries.

### 1.4 Import cost control `[ ]` — S–M

A 50k import currently fires 50k LLM calls with no switch. Add `?enrich=metadata` (or a per-batch flag) that runs fetch/extract/archive but skips the LLM step, leaving `enrich_status` in a state that a later bulk "enrich with LLM" action can pick up in controlled batches (`server/src/routes/import.ts`, `server/src/import/run.ts`, `server/src/pipeline/enrich.ts`).

**Done when:** a corpus can be imported metadata-only, then LLM-enriched later in batches.

### 1.5 Ops visibility `[ ]` — S

- `GET /api/jobs?status=failed&type=enrich` — failed jobs with their `error` text (currently only visible via sqlite3).
- `GET /api/stats` — counts by `enrich_status`/`content_type`, queue depth, total bookmarks, archive disk usage.
- `app.onError` in `server/src/index.ts` — log stack, return JSON 500 (currently route exceptions produce no server-side log).
- Upgrade `/health` to probe DB (one cheap query).

**Done when:** during an import you can see backlog, failures, and errors via curl without touching the DB file.

---

## Batch 2 — Backup / restore (permanence)

### 2.1 Restore path for Amber's own export `[ ]` — M–L

The zip/JSON export can't be re-ingested — the importer only parses Netscape/CSV (`server/src/import/parse.ts`), so a restore loses notes, gists, summaries, topics, read flags, provenance, and all archives. For a "permanent library" this is the main data-loss gap.

- Add JSON (and zip-with-archives) import: upsert by `canonical_url`, restore archive/thumb/favicon files, preserve ids where possible.
- Round-trip test: export → wipe → import → assert equality on all user-visible fields.

**Done when:** export → fresh server → import reproduces the library, including archives.

### 2.2 Scheduled DB backup `[ ]` — S

Only manual zip export exists, and DEPLOY.md recommends a raw file snapshot — unsafe under WAL (`server/src/db.ts:15`). Add a daily `db.backup()` (better-sqlite3 native online backup) to `dataDir/backups/` with rotation (keep N). Update DEPLOY.md's backup section to point at these files (plus the archives dir).

**Done when:** consistent daily snapshots appear and rotate; DEPLOY.md no longer recommends raw copies of a live WAL DB.

### 2.3 Graceful shutdown + DB hygiene `[ ]` — S

- `SIGTERM`/`SIGINT` handler in `server/src/index.ts`: stop claiming new jobs, abort in-flight job signal, close DB (checkpoints WAL).
- `db.ts`: set `busy_timeout` and `synchronous = NORMAL` (WAL-safe, large write-throughput win for imports).

**Done when:** Dokku deploy/restart doesn't hard-kill mid-job work and the DB closes cleanly.

### 2.4 Delete leaves orphan files `[ ]` — S–M

`DELETE /bookmarks/:id` (`server/src/routes/bookmarks.ts:219`) leaves `archives/{id}.html` (up to 300MB) and thumbs/favicons on disk forever; delete is also a hard destructive op with no undo. Move the row (as JSON) + its files to a `trash/` dir on delete; purge trash after 30 days in `maintenance()`. Solves both the disk leak and accidental deletion.

**Done when:** delete reclaims disk (eventually) and is recoverable for 30 days.

---

## Batch 3 — UI robustness & UX

### 3.1 Error surfacing everywhere `[ ]` — S–M

No try/catch on `saveNote`/`toggleRead`/`del` and the detail-load `$effect` (`web/src/lib/Detail.svelte:16-49`), `Card.svelte` retry, `Settings.svelte` download/retryFailed. A failed PATCH leaves `saving=true` forever with no feedback. Also `api.ts` throws on 401 but nothing routes to Settings.

- One small toast/error primitive in the store; catch and surface in every action.
- 401 → `store.page = "settings"` with a message.

**Done when:** killing the server mid-use produces visible errors, not frozen buttons.

### 3.2 Keyboard navigation `[ ]` — S–M

Nothing today — even Esc closes nothing. Add: `Esc` closes Detail/Reader/archive overlay; `/` focuses search; `j`/`k` (or arrows) move card focus; `Enter` opens detail; `o` opens original; `r` toggles read. (`web/src/App.svelte`, `Detail.svelte`, `Reader.svelte`, `TopBar.svelte`)

**Done when:** the library is fully navigable without the mouse.

### 3.3 Grid scalability `[ ]` — S first, L if needed

All loaded cards stay in the DOM (`web/src/App.svelte:39-43`, page size 50). First: `content-visibility: auto; contain-intrinsic-size: <card estimate>` on `.card` — one CSS rule, native offscreen skipping. Measure with 20k rows; only consider real windowing if still heavy.

**Done when:** scrolling a 20k-bookmark grid stays smooth.

### 3.4 URL routing / deep links `[ ]` — M

All state in-memory (`web/src/lib/store.svelte.ts:3-19`): refresh drops search/filters/open detail; back button exits the app. Sync `q/type/topic/read/detail id/page` to `location.hash` (or History API); back closes the Detail panel.

**Done when:** refresh preserves state; back button behaves; filter URLs are shareable.

### 3.5 Enrichment status polling `[ ]` — M

`pollPending` fires up to 20 sequential GETs every 2s and silently gives up after 30 rounds — shimmer stuck until reload (`web/src/lib/store.svelte.ts:72-96`). Add a batched status endpoint (`GET /api/bookmarks/status?ids=...`), poll that, and add a terminal UI state ("still processing").

**Done when:** post-import, hundreds of pending cards resolve without hammering and never strand the shimmer.

### 3.6 Unsaved-note protection `[ ]` — S

Clicking the backdrop discards a typed note silently (`web/src/lib/Detail.svelte:28`). Autosave on blur/debounce (fits the zero-question ethos) rather than a confirm dialog.

**Done when:** a typed note survives any way of closing the panel.

### 3.7 Bulk operations `[ ]` — M

No multi-select. Post-import triage (dead links, junk) is one-click-at-a-time. Add shift-click/checkbox selection + action bar (delete, mark read; topic assign later once vocabulary exists). Server endpoints exist per-item; add batched variants if round-trips hurt.

**Done when:** 50 junk bookmarks can be deleted in two gestures.

### 3.8 Sort + domain filter `[ ]` — S–M

Only implicit saved_at-desc. Cheap high-value: click a card's domain → filter by domain. Then sort options (title, domain, date) via list API params. (`web/src/lib/TopBar.svelte`, `Card.svelte`, `store.svelte.ts`, server list route)

### 3.9 Accessibility pass `[ ]` — M

`Detail.svelte`: `role="dialog"`, `aria-modal`, focus trap, focus restore on close. `Card.svelte`: remove invalid nested-interactive (retry button inside `role="button"` article), Space activates. `TopBar` chips: `aria-pressed`. `aria-live` for loading/error. Keyboard work overlaps 3.2 — do together.

---

## Batch 4 — Pipeline quality

### 4.1 Non-HTML content handling `[ ]` — S gate, M for PDF path

`fetchPage` never checks `content-type` (`server/src/pipeline/fetcher.ts:154-166`) — a bookmarked PDF/image is UTF-8-decoded and fed to Defuddle: garbage `content_text` pollutes FTS and the LLM prompt. Minimum: gate extraction on `text/html`, fall back to title/URL-only enrichment. Later: store PDFs via the unused `media_ref`/`media_status` columns.

### 4.2 Charset handling `[ ]` — S–M

Everything decodes as `utf8`; ISO-8859-2 pages (common on .sk/.cz sites) become mojibake in titles, content_text, FTS. Sniff charset from Content-Type header / `<meta charset>`, decode with `TextDecoder`. (`fetcher.ts:164`, `server/src/http-util.ts`)

### 4.3 Search relevance + snippets `[ ]` — M

FTS results ordered by `saved_at` only (`server/src/routes/bookmarks.ts:113-123`); at scale the best hit is buried. Add `sort=relevance` using `bm25()` column weights (title > gist > note > content_text), return `snippet()` for the results list; web UI shows snippet + result count.

### 4.4 Archive serving streams `[ ]` — S

`fs.readFileSync` on up to 300MB archives blocks the event loop (`bookmarks.ts:278`; same pattern for assets at `index.ts:93`). Use `fs.createReadStream` → `Readable.toWeb`.

### 4.5 Raw-HTML fallback base URL `[ ]` — S

Non-monolith fallback stores raw HTML as-is (`server/src/pipeline/archive-fallback.ts:73`); served from Amber's origin all relative assets 404. Inject `<base href="{finalUrl}">` when storing.

### 4.6 `fetchJson` size cap `[ ]` — S

oEmbed fetch buffers unbounded via `res.json()` (`fetcher.ts:169-178`) — the only fetch path without a stream limit. Route through `readStreamLimited`.

### 4.7 Reader fidelity `[ ]` — M–L

`Reader.svelte` renders `content_text` split on blank lines — headings, links, images, code lost. Store sanitized reader HTML server-side (reuse the archive scrubbing pipeline) and render in the existing `sandbox=""` iframe pattern. Remember scroll position per bookmark.

---

## Batch 5 — Extension

### 5.1 `archive_coming` failure signal `[ ]` — S

`background.ts:23` promises an archive, but capture/upload failure paths (`background.ts:56-76`) bail silently — server defers enrichment for a snapshot that never comes (rescued only by the maintenance sweep). Send an explicit "no archive" signal (e.g. `DELETE`/flag endpoint or empty PUT convention) on every failure path; retry the upload once.

### 5.2 Capture timeout + size safety `[ ]` — M

No timeout around `__amberCapture()` — `loadDeferredImages` can hang on pathological pages; the whole snapshot crosses `executeScript` serialization as one giant string (tens of MB with data-URI images). Add `Promise.race` timeout; consider uploading from page context or chunked messaging if size limits bite in practice.

### 5.3 Save-page context menu + options nudge `[ ]` — S

Context menu is link-only (`background.ts:8-13`) — add `"page"` (and `"selection"` → note). On "not configured" (`extension/lib/amber.ts:41`), call `browser.runtime.openOptionsPage()` instead of just a toast.

### 5.4 Offline save queue `[ ]` — M

Server unreachable → save lost with a toast (`background.ts:50-53`). Queue failed saves in `storage.local`, retry on next action/alarm.

---

## Batch 6 — Tests

### 6.1 SSRF guard unit tests `[ ]` — S

Zero tests on the self-described load-bearing component (`server/src/pipeline/fetcher.ts:16-107`). Export the helpers; cover `isPrivateIp` edges (0.0.0.0, 100.64/10, IPv6-mapped, fe80::), hostname rules, redirect-hop re-validation.

### 6.2 Enrichment pipeline tests `[ ]` — M

`enrichBookmark` untested, especially the redirect-merge branch (`server/src/pipeline/enrich.ts:134-167`) — note concat, topic migration, row deletion. Mock `fetchPage`.

### 6.3 Queue/timeout/maintenance tests `[ ]` — S–M

`runWithTimeout` abort path, lease reclaim, `maintenance()` rescue (regression for 1.1).

### 6.4 Auth middleware tests `[ ]` — S

Token match, brute-force window, proxy trust (`server/src/auth.ts`).

### 6.5 Frontend test setup `[ ]` — M

Zero tests, no runner in `web/` or `extension/`. Add Vitest; cover pure logic first: `web/src/lib/format.ts`, store filter/pagination/poll logic, `extension/lib/amber.ts` with mocked fetch/`browser.storage`.

---

## Batch 7 — Mobile & later

### 7.1 PWA + Web Share Target `[ ]` — M

No mobile save path except the bookmarklet. Minimal manifest + service worker + `share_target` → Android share-sheet saves (provenance `share_sheet` already exists in `web/src/lib/format.ts:41`).

### 7.2 Dedup UX `[ ]` — S

API returns `duplicate: true` but UI shows nothing. Show "first saved {date}" per design doc §10 v2.

### 7.3 Cache-Control hardening `[ ]` — S

`Cache-Control: no-store` on API responses containing notes/content. Tighten asset filename regex (`server/src/index.ts:78`) to reject leading dots.

---

## Batch 8 — Docs & deploy fixes (10 minutes, anytime)

- `[ ]` DEPLOY.md:22 — `git push dokku main` → `master`.
- `[ ]` DEPLOY.md — add `AMBER_TRUST_PROXY=1` (required behind Dokku nginx per docs/STATUS.md:36) and nginx `client_max_body_size` note (300MB archive PUTs vs 1MB default).
- `[ ]` DEPLOY.md:27 — replace raw-snapshot backup advice (unsafe under WAL) with 2.2's backup files.
- `[ ]` TODO.md — stale: says 34 tests (46 real); lists reader mode and server-side archive fallback as open (both done).
- `[ ]` Dockerfile — add `USER node`, `HEALTHCHECK`, root `.dockerignore` (exclude node_modules, `server/data/`, `.git`).

---

## Deliberately out of scope

- **Topic vocabulary** — the one open design decision; user decides after real corpus import (CLAUDE.md).
- Gemini YouTube path, Dokku deploy execution, Safari conversion, live-browser extension test — blocked on user keys/machine (docs/STATUS.md).
- Design-doc v3+ items: chat-with-library, MCP server, embeddings-related items, widgets, Alexandria migration.

## Suggested execution order

1. **Batch 1** (import survival) + Batch 8 (docs, trivial) — before the real-corpus import.
2. **Batch 2** (backup/restore) — permanence is the product promise.
3. **Batch 3** items 3.1–3.5 — daily-use robustness right after the corpus lands.
4. **Batches 4–6** interleaved — pipeline quality and tests per touched area (write tests with the fix).
5. **Batch 7** — mobile once desktop flow is proven.
