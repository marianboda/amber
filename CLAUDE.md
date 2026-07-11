# CLAUDE.md — working notes for Amber

Guidance for Claude Code working in this repo. Read [`README.md`](README.md) for setup, [`amber-design-doc.md`](amber-design-doc.md) for the product/architecture spec, [`TODO.md`](TODO.md) for build status, and [`docs/STATUS.md`](docs/STATUS.md) for the latest handover state.

## What this is

Amber — a single-user permanent bookmark library. Server is the source of truth; clients (web UI, browser extension, bookmarklet, curl) are thin. Save is instant + zero-question; all intelligence (labeling, summary, archive) runs asynchronously after capture. Nothing decays or nags — it's a reference library, not a reading queue.

## Three packages, one repo

- `server/` — Hono + TypeScript, Postgres (`pg`) with a `tsvector` FTS column, in-process job queue. This is where almost all logic lives. (Metadata is in Postgres via `DATABASE_URL`; archives/cached assets/backups/trash are files under `DATA_DIR`/`AMBER_DATA_DIR`. The data layer in `src/db.ts` is an async `prepare().get/all/run` adapter over a pg Pool with a `tx()` helper — call sites `await` it. Ported from SQLite; see `docs/POSTGRES.md`.)
- `web/` — Svelte 5 (runes: `$state`/`$effect`/`$props`) + Vite. Built static, served by the server from `web/dist`. Talks only to `/api`.
- `extension/` — WXT. Chrome MV3 + Firefox MV2 from one codebase. Captures a self-contained page snapshot (single-file-core) at save time.

## Conventions and gotchas

- **ES modules, `.js` import specifiers.** Server is `"type": "module"` with `NodeNext`; import local files as `./foo.js` even though the source is `.ts`.
- **Run commands from the package dir.** `cd server && npm ...`, not repo root (there is no root package.json). `cd` in a compound shell command can trip the sandbox — prefer absolute paths or per-package invocation.
- **zsh `noclobber` is on.** `>` fails if the file exists; use `>!` to overwrite (bit me repeatedly when redirecting server logs in tests).
- **Migrations auto-apply on boot** from `server/migrations/*.sql`, tracked in `schema_migrations`. Add the next numbered file; never edit an applied one. Current: 001 schema, 002 FTS5, 003 title_lock, 004 FTS-trigger-scope + import_batch.
- **The job queue is the executor, the `jobs` table is the source of truth.** Handlers must be idempotent — a crash mid-job re-runs it on boot; a lease reclaim (updated_at > 600s) and a 180s per-job abort also re-run them. Enrichment checks its `AbortSignal` before terminal writes.
- **SSRF guard is load-bearing.** All outbound fetches go through `server/src/pipeline/fetcher.ts` `guardedFetch`, which pins to the resolved IP via an undici `Agent` (uses undici's *own* `fetch` — Node's built-in rejects a foreign dispatcher). Don't add a raw `fetch()` to a user-supplied URL. `AMBER_ALLOW_PRIVATE=1` bypasses it for local dev.
- **Archives are replayed on our origin**, so page HTML is scrubbed of scripts three ways (client capture blocks JS, `scrubScripts` server-side, CSP sandbox on serve) and the web viewer renders them in a `sandbox=""` iframe. Keep all three when touching archive code.
- **Cached assets** (`/assets/thumbs`, `/assets/favicons`) are served without auth (so `<img>` works) but names are non-enumerable (uuid/hash) and only images are served, with CSP + nosniff.
- **FTS update trigger is scoped** to `UPDATE OF title,gist,note,content_text` — don't let unrelated column writes re-index FTS.

## Workflow expectations (from the session that built this)

- After a nontrivial change: `npm run typecheck` and `npm test` in `server/`, `npm run build` in `web/` and `extension/`. Verify behavior live with a real server + `curl`/sqlite3 when it touches the pipeline, not just tests.
- **Commit per logical chunk.** Commit messages end with the `Co-Authored-By` trailer. Branch is `master`. Remote `origin` = `git@github.com:marianboda/amber.git`. Push when the user asks or at natural handover points.
- **Code review with `codex`** (`codex exec --sandbox read-only "<prompt>"`, run in background). Four passes done so far (9→7→6→5 findings, all fixed). Each pass: fix every valid finding, add regression tests, re-verify, commit, push. When resuming reviews, tell codex which issues are already fixed so it doesn't re-report.
- Docs (README/CLAUDE/design) are written in normal prose. The user's session may run a "caveman" terse-output mode for chat — that affects chat replies only, never file contents, code, or commit messages.

## The one open design decision

**Topic vocabulary** is deliberately deferred (design doc §3, §12). Topics table starts empty; enrichment runs without classification until a vocabulary exists. Do **not** design or implement a vocabulary scheme without asking the user — they want to decide the approach after a real corpus is imported. Everything else in v1 is decided.

## Not yet verified end-to-end (need the user's keys/machine)

Gemini YouTube summarization path (written, never run with a key), Dokku deploy, Safari conversion, and the extension clicked live in a real browser (builds pass, logic tested). Flagged in `docs/STATUS.md`.
