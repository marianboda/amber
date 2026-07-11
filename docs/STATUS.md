# Amber — Handover Status

Last updated: 2026-07-10. This file captures the state of the project at session handover to another machine. Pair it with `TODO.md` (phase checklist), `docs/ENHANCEMENTS.md` (enhancement program, all batches done), and `CLAUDE.md` (working conventions).

## Where things stand

v1 is built, tested, and reviewed, plus a full enhancement program (8 batches, see `docs/ENHANCEMENTS.md`) is implemented. The whole thing runs locally today with `AMBER_TOKEN=devtoken npm run dev` in `server/`. Nothing here is a prototype — every phase below ends in a runnable, tested state.

| Area | State |
|---|---|
| Server + API (CRUD, dedup, filters, topics, import/export) | Done, tested |
| Enrichment pipeline (fetch, Defuddle, YouTube/Gemini branch, LLM, restart-safe queue) | Done, tested (Gemini path not run with a real key) |
| Web UI (Svelte 5: library grid, filters, detail, reader, settings, bookmarklet) | Done |
| Browser extension (WXT, Chrome MV3 + Firefox MV2, page capture, offline queue) | Builds pass; not yet clicked live in a browser |
| Full-text search (FTS5, bm25 relevance + snippets) | Done, tested |
| Page archival (extension single-file + server-side monolith/raw fallback with base-href) | Done, tested |
| Cached thumbnails + favicons (link-rot immunity) | Done, tested |
| Backup **and restore** (zip/JSON round trip incl. archives; daily DB snapshots; trash) | Done, tested |
| Import at scale (chunked transactions, metadata-only mode, enrich-missing batches) | Done, tested |
| Ops (`/api/jobs`, `/api/stats`, onError logging, DB-probing `/health`, graceful shutdown) | Done, tested |
| Web UX (keyboard nav, hash routing, bulk ops, autosave notes, batched polling, a11y) | Done |
| Mobile save path (PWA + Android share target) | Built; not yet installed on a phone |
| Test suites | server 105 · web 9 · extension 6, all green |
| Deploy | Dockerfile (non-root + healthcheck) + DEPLOY.md ready; **never actually deployed** |

## Not verified end-to-end (needs your keys / machine / a browser)

1. **Gemini YouTube summaries** — code path written, never executed with a real `GEMINI_API_KEY`.
2. **Dokku deploy** — `Dockerfile` + `DEPLOY.md` ready, never run on the server.
3. **Safari extension** — `xcrun safari-web-extension-converter` step never run (needs Xcode).
4. **Extension live** — builds and typechecks pass; logic tested, but not loaded and clicked in a real browser. Load `extension/.output/chrome-mv3` unpacked to try it.
5. **PWA share target** — manifest + `/share` receiver built and smoke-tested over HTTP, but not installed on an Android device (needs the deployed HTTPS instance).
6. **Keyboard nav / bulk ops / routing in a real browser** — svelte-check and unit tests pass; a quick manual click-through after deploy is recommended.

## The one open decision — do not resolve without the user

**Topic vocabulary approach** (design doc §3 and §12). Deliberately deferred. Topics table starts empty; enrichment runs classification-free until a vocabulary exists (the pipeline already supports this). The user wants to choose the approach *after* importing a real corpus — the §3 "AI proposes, user approves" flow is a candidate sketch, not a commitment. Everything else in v1 is decided.

## Immediate next steps for whoever picks this up

1. **Import a real corpus.** Export browser bookmarks → Settings → Import (needs a real LLM key configured for gist/summary; ~$0.001/link). This is the "v1 daily-usable" milestone and the input to the vocabulary decision.
2. **Deploy** per `DEPLOY.md` (generate a strong `AMBER_TOKEN`, set `AMBER_TRUST_PROXY=1` behind Dokku's nginx).
3. **Decide the topic vocabulary** with the user, then build Phase 5 (see `TODO.md`).
4. **Phase 7** — SwiftUI iOS/macOS apps — untouched.

## Code review history

Reviewed with `codex` (OpenAI CLI) in four independent read-only passes. All findings valid; all fixed with regression tests. Trend: 9 → 7 → 6 → 5 findings, severity falling from data-loss bugs to hardening/perf edge cases.

- **Pass 1 (`91e3ba4`)** — 9: duplicate-save overwrote original archive; SSRF; post-redirect dedup deleted a bookmark after 201; active-SVG assets; non-idempotent AI topics; unbounded body reads; concurrent-dup 500; token in `storage.sync`; partial PATCH before topic validation.
- **Pass 2 (`75a329d`)** — 7: non-http URLs (stored XSS); SSRF still bypassable via DNS rebinding; size limits buffered before reject; archive-overwrite race; redirect dedup dropped non-note fields; pagination skipped rows sharing `saved_at`; XFF spoofable.
- **Pass 3 (`2ddfeb9`)** — 6: multipart OOM before size check; negative `limit` = unbounded; enrichment clobbered user-edited title; extension archived wrong page after navigation; no lease for wedged jobs; detail-panel stale-response race.
- **Pass 4 (`b1bd001`)** — 5: monolith bypassed SSRF guard; timed-out job kept mutating; archive write failure misclassified as dead link; FTS write amplification; import status conflated same-filename imports.
- **Pass 5 (batch 1, `9c44fa5`)** — 0 findings.
- **Pass 6 (batches 2–7 combined)** — 5, all fixed with regression tests: per-type stale-lease cutoff (30-min restores were reclaimable at 10); restore extraction writes temp-then-rename (crash mid-stream left truncated archives that later runs treated as complete); restored `archive_ref`/`media_ref`/asset URLs sanitized + `archivePath()` guard at every use site (crafted export JSON could read/move files outside dataDir); zip-inflation caps (1GB metadata JSON, 512MB/entry, 20GB total); extension offline queue keeps recoverable failures (401/429/5xx/unconfigured) instead of silently dropping queued saves.

Resume reviews by telling codex which issues are already fixed.

## Key decisions made this session (beyond the design doc)

- **Web framework: Svelte 5** (the design doc left tech stack loose; user chose Svelte).
- **LLM config uses standard provider env vars** (`OPENAI_API_KEY`/`GEMINI_API_KEY`) with auto-detection — user rejected a provider-agnostic key var.
- **No-key = metadata-only mode** — server still fetches, extracts, archives, and searches; just no gist/summary. Makes local testing keyless.
- **Page archival pulled forward from v2** and done client-side in the extension (single-file-core) so it works behind auth and survives dead URLs; server-side monolith/raw fallback covers non-extension saves.
- **Archive size cap 300MB** (user explicitly wanted it large, rejected 20MB).
- **FTS5 search, reader mode, zip backup, bookmarklet, read filter** — all pulled forward / added beyond the original v1 scope.

## Git / handover

- Branch `master`, remote `origin` = `git@github.com:marianboda/amber.git`. Everything is pushed.
- Not committed (gitignored): `node_modules/`, build output (`dist/`, `.output/`, `.wxt/`), `data/` (archives + assets + backups + trash), `.env`, `.claude/`. Metadata is in Postgres (`DATABASE_URL`), not in `data/`.
- `server/data/` is local scratch — the real data dir on deploy is the Dokku storage mount.
- No secrets are in the repo. Set `AMBER_TOKEN` and any LLM key via env on each machine.
