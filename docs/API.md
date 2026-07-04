# Amber API reference

All `/api/*` endpoints require `Authorization: Bearer <AMBER_TOKEN>`. Bodies are JSON unless noted. This reflects the implemented routes (a superset of design-doc §4).

## Bookmarks

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/bookmarks` | `{ url, note?, saved_from?, device?, referrer?, source_detail?, saved_at?, archive_coming? }`. Rejects non-http(s) URLs (400). Returns `201 { id }`; if the canonical URL already exists, `200 { id, duplicate:true, saved_at }` (bumps nothing). `archive_coming:true` defers enrichment until the snapshot PUT arrives. |
| `GET` | `/api/bookmarks` | Query: `topic`, `type`, `q`, `read` (`0`/`1`), `before` (cursor), `limit` (1–200, default 50). `q` uses FTS5 over title/gist/note/content_text (prefix match), LIKE fallback. Returns `{ bookmarks, next_before }`; `next_before` is a stable `"<saved_at>.<id>"` cursor. |
| `GET` | `/api/bookmarks/:id` | Full bookmark incl. `topics`. |
| `GET` | `/api/bookmarks/:id/status` | `{ id, enrich_status, fetch_status, gist }` — for the extension toast. |
| `PATCH` | `/api/bookmarks/:id` | `{ note?, title?, is_read?, topics? }`. Topics validated before any write (atomic). Setting `title` locks it against later enrichment overwrites. Unknown topics → `400 { error, topics }`. |
| `DELETE` | `/api/bookmarks/:id` | |
| `POST` | `/api/bookmarks/:id/retry` | Re-enqueue enrichment for one bookmark. |
| `POST` | `/api/bookmarks/retry-failed` | Re-enqueue all `failed` enrichments. Returns `{ retried }`. |
| `PUT` | `/api/bookmarks/:id/archive` | Body: raw HTML page snapshot (text/html, ≤300MB, streamed). First write wins — won't overwrite an existing snapshot unless `?replace=1`. Scrubs scripts, stores under the data dir, re-enqueues enrichment to re-extract from the snapshot. |
| `GET` | `/api/bookmarks/:id/archive` | Serves the stored snapshot with `Content-Security-Policy: sandbox; script-src 'none'`. |

## Topics

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/topics` | `{ topics: [{ id, name, color, count }] }`. |
| `POST` | `/api/topics` | `{ name, color? }`. 409 if exists. |
| `DELETE` | `/api/topics/:id` | Reassigns its bookmarks to `unsorted`; can't delete `unsorted`. |

## Import / export

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/import` | multipart `file` **or** raw body: Netscape bookmark HTML or CSV/URL list. Body bounded to 100MB (streamed). Dedups within the file and against the library. Returns `202 { job_id, count }`; runs as a throttled background batch preserving `ADD_DATE`. |
| `GET` | `/api/import` | Recent import jobs (for resuming progress after a reload). |
| `GET` | `/api/import/:job_id` | `{ status, progress, enrichment }` — enrichment counts scoped to that import batch. |
| `GET` | `/api/export?format=json\|html\|zip` | `json` = full fidelity; `html` = Netscape (topics as folders); `zip` = metadata JSON + archives + cached assets (full backup, streamed). |

## Unauthenticated

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | `{ ok: true }`. |
| `GET` | `/assets/:kind/:file` | Cached `thumbs`/`favicons` images only, non-enumerable names, `nosniff` + CSP. Public so `<img>` tags work. |
| `GET` | `/*` | Static web UI (SPA fallback to `index.html`). |

## Auth notes

Single bearer token, timing-safe compared. Brute-force guard: 20 bad tokens/min/IP → `429`. IP comes from the socket by default; set `AMBER_TRUST_PROXY=1` to trust `X-Forwarded-For` behind a proxy. CORS is open on `/api` so the bookmarklet can POST from any origin (auth is still the token).
