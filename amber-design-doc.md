# Amber — Design Document

Personal bookmarking system. Single primary user. Reference library, not a reading queue. Named for permanence: what you save is preserved intact, like an insect in amber.

## 1. Product definition

**What it is:** a permanent, searchable library of links. Save frictionlessly from any browser or Apple device; the system labels, summarizes, and previews everything automatically; retrieval is scroll-recent → filter → search.

**Core principles**
1. Saving asks zero questions. All intelligence runs after capture, asynchronously.
2. Everything is permanent. Nothing decays, expires, or nags. No unread counts.
3. Time is the spine. Main view is reverse-chronological.
4. Organization is automatic: closed-vocabulary AI topics + content type. Manual correction possible, never required.
5. Own the data: export always available; stored page copies (v2) make the library immune to link rot.

**Non-goals (anti-features, permanent):** no reading queue, no folders or nesting, no manual filing at save time, no save-all-tabs, no decay/auto-archive, no social layer, no open-vocabulary AI tags. A quiet **read flag** exists (§3) but is never "in your face": no unread counts, no badges, no default filtering by it. **Icebox (not designed for now):** sharing (per-link, public pages), digests, typed per-domain cards, web app for others.

## 2. Architecture

```
┌─────────────┐  ┌──────────────┐  ┌─────────────┐
│ Browser ext │  │ iOS/Mac app  │  │ CLI / API   │
│ (Ch/Ff/Saf) │  │ + share ext  │  │             │
└──────┬──────┘  └──────┬───────┘  └──────┬──────┘
       │    HTTPS + token auth            │
       └───────────┬────────────┬─────────┘
                   ▼
            ┌─────────────┐
            │   Server    │  source of truth
            │  REST API   │
            │  job queue  │──► fetch metadata ──► extract ──► LLM
            │  SQLite     │──► (v2) archive page / yt-dlp
            └─────────────┘
```

- **Server is the source of truth.** All clients are thin: they POST saves and GET lists/search. This is what solves cross-browser + cross-device sync.
- **SQLite** as the database for v1–v2 (single user; FTS5 available for v2 search; trivial backup = copy one file). Migration path to **Alexandria** (in-house Postgres provisioning + auth + user management) planned around v3–v4 — see §10. Keep SQL portable (avoid SQLite-only tricks outside FTS5) to keep that migration cheap.
- **Job queue** (in-process is fine): every save enqueues an enrichment job. Save API returns immediately. **Restart-safe:** every job is a row in a `jobs` table (`status: pending|running|done|failed`); the in-process queue is only the executor. On startup the server re-enqueues all `pending` and `running` jobs. Jobs are idempotent (re-running a half-finished enrichment just overwrites), so a crash mid-job costs at most one duplicate run, never a lost job.
- **Auth:** single bearer token in a config file / client settings for v1–v2. No user accounts until Alexandria integration; clients should treat the token as an opaque header so swapping in real auth later doesn't touch client logic.
- **Deployment:** **Dokku on the existing server** — `git push` deploys, Dokku handles the container, Let's Encrypt TLS, and domain routing. SQLite file and (v2) archive directory live on a persistent storage mount (`dokku storage:mount`), so deploys never touch data. Backup = cron rsync/snapshot of that mount.

## 3. Data model

```sql
CREATE TABLE bookmarks (
  id            TEXT PRIMARY KEY,           -- uuid
  url           TEXT NOT NULL,
  canonical_url TEXT,                       -- after resolving redirects/utm-stripping
  title         TEXT,
  domain        TEXT,
  favicon_url   TEXT,
  og_image_url  TEXT,
  saved_at      INTEGER NOT NULL,           -- unix; import preserves ADD_DATE
  content_type  TEXT,                       -- article|tool|video|repo|paper|thread|product|other
  gist          TEXT,                       -- one sentence, <=120 chars
  summary       TEXT,                       -- one paragraph
  note          TEXT,                       -- user's note (may be pre-filled from selected text)
  is_read       INTEGER DEFAULT 0,          -- quiet flag; set explicitly by user (or auto on
                                            -- reader-mode open in v2). No counts, no badges;
                                            -- usable as a filter/smart-search term only.
  -- provenance
  saved_from    TEXT,                       -- extension|share_sheet|context_menu|import|api
  device        TEXT,                       -- hostname / device name
  referrer      TEXT,                       -- page where the link was found (context-menu saves)
  source_detail TEXT,                       -- e.g. "chrome-export", source app name
  -- pipeline
  enrich_status TEXT DEFAULT 'pending',     -- pending|done|failed
  fetch_status  TEXT DEFAULT 'pending',     -- pending|ok|dead
  -- v2 fields, in schema from day one
  content_text  TEXT,                       -- extracted article text (FTS5 indexed in v2)
  archive_ref   TEXT,                       -- path to stored page copy
  media_ref     TEXT,                       -- path to yt-dlp download
  media_status  TEXT                        -- null|queued|downloading|done|failed
);

CREATE TABLE topics (
  id    TEXT PRIMARY KEY,
  name  TEXT UNIQUE NOT NULL,               -- closed vocabulary, user-curated (~15)
  color TEXT
);

CREATE TABLE bookmark_topics (
  bookmark_id TEXT REFERENCES bookmarks(id),
  topic_id    TEXT REFERENCES topics(id),
  by_ai       INTEGER DEFAULT 1,            -- 1=AI-assigned, 0=user-assigned/corrected
  PRIMARY KEY (bookmark_id, topic_id)
);
```

**Vocabulary approach: TBD — decide later, after a real corpus is imported.** Topics table starts empty; enrichment runs without classification until the vocabulary exists (pipeline already supports this, §5). The sketch below is one candidate flow, not a commitment:

1. First import (or first ~50 saves) runs enrichment *without* classification — gist/summary/type only; everything is topic-less.
2. Server then runs a one-shot **vocabulary proposal job**: LLM reads the corpus (titles + domains + gists) and proposes ~10–20 topics with example bookmarks for each.
3. User reviews in settings — rename, merge, delete, add — and approves.
4. Batch classification runs over the whole library against the approved vocabulary.

Ongoing: same closed-vocabulary rules as before (1–3 topics per bookmark, `unsorted` on low confidence). When `unsorted` accumulates a cluster, the app proposes a new topic; user approves; affected bookmarks re-classify. The vocabulary is always AI-proposed, user-approved — never AI-invented silently, never something the user has to dream up from a blank page.

Rules: 1–3 topics per bookmark; `unsorted` if classifier confidence is low. Deleting a topic reassigns its bookmarks to `unsorted`.

Provenance fields are captured from v1 even though the UI barely shows them — they cannot be retrofitted.

## 4. API

All endpoints under `/api`, bearer token required.

```
POST /bookmarks            body: { url, note?, saved_from, device?, referrer?, source_detail? }
                           → 201 { id }  (immediate; enrichment async)
                           If canonical_url already exists: → 200 existing bookmark,
                           bump nothing, respond with { id, duplicate: true, saved_at }.
GET  /bookmarks            ?topic=&type=&q=&read=&before=&limit=50   (reverse-chron; q searches
                           title+gist+note in v1, +content_text in v2; read filter optional,
                           never applied by default)
GET  /bookmarks/:id
PATCH /bookmarks/:id       { topics?, note?, title?, is_read? }
DELETE /bookmarks/:id
GET  /topics               / POST /topics / DELETE /topics/:id
POST /import               multipart: Netscape HTML | CSV/URL list → { job_id, count }
GET  /import/:job_id       progress
GET  /export?format=json|html
GET  /bookmarks/:id/status enrichment status (used by extension toast)
```

## 5. Ingestion pipeline

Per save, background job:

1. **Normalize URL** — resolve redirects, strip tracking params → `canonical_url`; dedup check (if the POST didn't already catch it).
2. **Fetch metadata** — GET page with a desktop UA; parse `<title>`, OpenGraph (`og:image`, `og:title`, `og:description`), favicon. On failure: `fetch_status=dead`, keep the bookmark (URL + any title still searchable).
3. **Branch by URL type:**
   - **YouTube** (`youtube.com/watch`, `youtu.be`): skip HTML extraction. Call **Gemini** with the video URL (Gemini accepts YouTube URLs natively) requesting the same structured output. Pull duration/channel from oEmbed. `content_type=video`. If the "archive video" setting is on → enqueue yt-dlp job (v2).
   - **Everything else:** extract main text with **Defuddle** (Node bundle) → `content_text`. If extraction yields nothing (SPA, paywall), fall back to og:description as LLM input.
4. **One structured LLM call** (default: a cheap model — GPT-4o-mini / Gemini Flash, ~$0.001/save; model + API key are server config, Ollama endpoint supported as alternative). While the vocabulary is empty (pre-bootstrap, §3), the call omits topics and returns gist/summary/type only; classification back-fills after vocabulary approval.

   System prompt (sketch):
   ```
   You classify and summarize a saved web page for a personal bookmark library.
   Owner context: software developer. Respond ONLY with JSON matching the schema.
   TOPICS — choose 1–3 ONLY from this list: {topic_names}.
   If nothing fits confidently, use ["unsorted"].
   gist: ONE sentence, max 120 characters, concrete, no fluff.
   summary: one paragraph, 3–5 short sentences, what it is and why it might matter.
   content_type: one of article|tool|video|repo|paper|thread|product|other.
   ```
   Input: title + url + first ~4,000 tokens of `content_text` (truncate; guard against
   context overflow). Output schema:
   ```json
   { "gist": "", "summary": "", "topics": [""], "content_type": "" }
   ```
   Validate: topics ∩ vocabulary only; drop unknown values; on parse failure retry once,
   then `enrich_status=failed` (bookmark still usable; retry button in UI).
5. **Save results**, `enrich_status=done`.

Rate-limit outbound fetches (importing thousands of links must not hammer sites or the LLM API; a few requests/sec is fine).

## 6. Capture clients

### 6.1 Browser extension (Chrome, Firefox, Safari)
- Built with **WXT** (one codebase → Chrome/Firefox; Safari via Apple's Safari Web Extension converter in Xcode).
- **Toolbar click / keyboard shortcut:** save current tab. If text is selected on the page, it's sent as `note`.
- **Right-click on any link → "Save to Amber":** saves *that* link, with `referrer` = current page URL, `saved_from=context_menu`.
- **Toast:** injected page toast or badge — "Saved ✓", then swaps to the gist when `GET /bookmarks/:id/status` reports done (poll ~2s, give up silently after 10s). No popup UI in v1.
- Settings: server URL + token, device name.

### 6.2 iOS / macOS
- **iOS app:** main view (see §7) + a **share extension**: Share → Amber → saved, toast, done. `saved_from=share_sheet`, `source_detail` = source app when available.
- **macOS:** same SwiftUI app (multiplatform target) + share extension. Menu-bar global-hotkey capture from any browser is a nice-to-have, not v1.

### 6.3 API/CLI
`curl -X POST .../api/bookmarks -d '{"url": "..."}'` — free by virtue of the API; a one-line shell alias counts as the CLI.

## 7. Main UI (web UI served by the server + the SwiftUI apps; same spec)

**Library view (the app):**
- Reverse-chronological **card grid**; toggle to compact list. Infinite scroll.
- **Card:** og_image (fallback: favicon on a colored tile derived from domain), favicon + domain, title, **gist**, topic chips, content-type icon, relative date. Whole card click → detail (v1) / reader (v2). Secondary click → open original URL.
- **Top bar:** search field; topic chips row; content-type filter. Filters combine (topic AND type AND query). Chips show counts.
- **Enrichment pending:** card renders immediately with URL/title, gist area shows a subtle shimmer until done; failed shows a retry glyph.
- **Detail panel:** full metadata, paragraph summary, note editor, topic editor (chip picker from vocabulary), a small read-flag toggle (subtle checkmark, no visual weight elsewhere in the UI), provenance line ("saved from MacBook via extension · found on news.ycombinator.com"), delete, open original.
- **Settings:** topics CRUD, LLM config, import, export, (v2) archive toggles.

Design tone: calm, dense enough to skim 50 items per screenful in list mode; the gist is the star of the card.

## 8. Import (v1)

- Accepts **Netscape bookmark HTML** (Chrome, Firefox any vintage, Safari) and a CSV/plain URL list fallback.
- Every imported URL goes through the standard pipeline (fetch + LLM), as a throttled background batch with a progress view. A few thousand links ≈ an hour and a couple of dollars of LLM calls.
- **Preserve `ADD_DATE`** as `saved_at` so history stays truthful. `saved_from=import`, `source_detail` = filename.
- **Discard folder names** (that's the mess being escaped) — but pass the folder path to the LLM as a classification hint.
- **Dedup across sources** at import time by canonical URL; first-seen wins, earliest date kept.
- Dead links are kept (`fetch_status=dead`), classified from title/URL alone.

## 9. Export (v1)

- `GET /export?format=json` — full fidelity, everything in the schema.
- `GET /export?format=html` — Netscape format (topics as folders) for re-import anywhere.
- Backup story: the SQLite file + (v2) the archive directory.

## 10. Roadmap

### v1 — Save + See  *(done when the Chrome bookmark bar is abandoned)*
Build order:
1. **Server + web UI** (served by the same app): API, SQLite, pipeline incl. YouTube/Gemini branch, provenance fields, library view (cards, filters, search over title/gist/note), topic + note editing, read flag, import, **vocabulary bootstrap flow (propose → review → approve → batch classify)**, export. Usable immediately — save via bookmarklet or `curl` until the extension lands.
2. **Extension** (WXT): click-save, right-click "Save to Amber", toast-with-gist.
3. **iOS/macOS app** with share extensions.

### v2 — Find + Read
- FTS5 over `content_text` → full-text search of everything ever saved.
- **Page archival:** store a self-contained copy at save time (Monolith or SingleFile-CLI); reader mode opens the **stored copy by default**, original one tap away; clean typography (one serif, size slider, dark mode — no theme gallery).
- **yt-dlp video archiving** behind a settings toggle + per-save override; background job, status on the bookmark, storage cap setting.
- Dedup UX: re-saving shows "first saved {date}".
- **Related items** on the detail view via embeddings over gist+title.

### v3 — Query
- Chat-with-library + **MCP server** (search, fetch, tag tools) so Claude/editors can query the library.
- Mac global quick-search hotkey (Spotlight-style palette); widgets.

### v3–v4 — Alexandria integration
- Migrate DB from SQLite to **Alexandria-managed Postgres** (schema is portable by design; FTS5 → Postgres full-text or keep a search sidecar).
- Replace bearer token with **Alexandria auth + user management** — this is also the gate for ever letting other people use Amber (add `user_id` to bookmarks/topics at this point, not before).
- Until then Alexandria stays entirely out of the codebase; no premature abstractions for multi-tenancy.

### Icebox
Sharing (per-link pages, public topic pages), digests/resurfacing, typed per-domain cards, save-all-tabs (rejected), multi-user UX beyond what Alexandria auth provides.

## 11. Tech defaults (secondary, swap freely)

| Piece | Default | Why |
|---|---|---|
| Server | Node/TypeScript (Hono or Fastify) | Defuddle is TS-native; one language with the extension |
| Web UI | **Svelte** (Vite build, served static by the server) | decided |
| DB | SQLite (+FTS5 in v2) | single user, one-file backup |
| Jobs | in-process queue (p-queue) persisted in a `jobs` table | no infra |
| Extraction | Defuddle (Node bundle) | modern Readability replacement |
| LLM | GPT-4o-mini or Gemini Flash; Gemini required for YouTube; optional Ollama | cost ≈ $0.001/save |
| Extension | WXT; Safari via Apple converter | one codebase, three browsers |
| Apps | SwiftUI multiplatform (iOS+macOS), URLSession client | native quality, shared code |
| Archival (v2) | monolith CLI | single-file HTML |
| Deploy | Dokku on existing server, persistent storage mount for SQLite + archives | git push to ship |

## 12. Open decisions
1. ~~Server location~~ — **decided: Dokku on existing server.**
2. ~~Build order~~ — **decided: web UI first**, then extension, then SwiftUI apps.
3. ~~Web UI framework~~ — **decided: Svelte.**
4. **Topic vocabulary approach — open.** Decide after a real corpus is imported; §3 bootstrap flow is a candidate, not a commitment.
