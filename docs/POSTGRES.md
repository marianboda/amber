# Postgres port assessment

Written 2026-07-11, when a Postgres database was provisioned for the Dokku
deploy. Amber v1 is SQLite-native by design (design doc §2; Postgres is the
v3–4 "Alexandria migration"). This documents what a port actually involves so
the timing can be decided with real numbers.

## Current reality

- `better-sqlite3` is used in **15 of 17 server source files** — 95 direct
  `prepare/transaction/pragma/exec/backup` call sites.
- The API is **synchronous**: routes and the job queue rely on statements
  completing inline. Postgres clients are async — every call site changes
  shape, and everything that calls those functions goes async too
  (`topicsForBookmarks`, `enqueueJob`, `runMaintenance`, the queue's claim
  loop, all route handlers).
- **FTS5 is load-bearing**: `bookmarks_fts` virtual table, trigger-synced,
  prefix matching, `bm25()` column-weighted ranking, `snippet()` highlights
  (batch 4). Postgres equivalent is `tsvector` + `ts_rank_cd` + `ts_headline`
  — similar power, different semantics (stemming vs prefix tokens), all six
  migrations rewritten, search queries rewritten, ranking re-tuned.
- **Queue semantics**: jobs are claimed with a single `UPDATE … WHERE id =
  (SELECT … LIMIT 1) RETURNING …` — fine in pg (`FOR UPDATE SKIP LOCKED` is
  actually nicer), but attempts/lease/reclaim logic all needs re-verification
  under real concurrency.
- **Backup/restore**: `db.backup()` (SQLite online backup API) and the
  zip-restore path assume a single database file. Postgres would use
  `pg_dump`, and the zip backup format changes.
- **Tests**: 109 server tests construct throwaway SQLite files per suite.
  They'd need a pg test harness (testcontainers or a scratch database).

## Honest estimate

2–4 focused days for the port + re-verification, plus re-tuning search
behavior. It invalidates none of the product code (routes/pipeline logic
stays), but touches nearly every file that talks to the database.

## What Postgres buys / doesn't buy

| | SQLite (today) | Postgres |
|---|---|---|
| Single user, one server process | perfect fit | works |
| Concurrent writers / multi-process | single-writer (fine for one app process) | better |
| Multi-user Alexandria future | needs this port eventually | ready |
| Full-text search | FTS5, built & tuned | tsvector port, re-tune |
| Backup | daily online snapshot to /data, zip round trip | pg_dump + still need /data for archives |
| Ops | zero moving parts (a file) | separate service to run/upgrade |

Note: archives (300MB HTML files), cached thumbnails/favicons, and trash live
on the **disk mount regardless** — Postgres only moves the metadata rows. The
`/app/data` mount stays either way.

## Recommendation

Ship v1 on SQLite (as designed), do the real-corpus import, decide the topic
vocabulary — then do this port as its own project when Alexandria/multi-user
actually needs it. A one-file database is an operational feature for a
single-user tool, not a compromise.

## If/when ported

1. Introduce a thin async repo layer first (mechanical extraction of the 95
   call sites), still SQLite-backed — verify tests still pass.
2. Swap the layer's implementation to `pg` behind `DATABASE_URL`; translate
   migrations (FTS5 → generated `tsvector` column + GIN index).
3. Port search (`websearch_to_tsquery`, `ts_rank_cd` weights A/B/C/D ≈
   title/gist/note/content, `ts_headline` for snippets).
4. Queue: move claim to `FOR UPDATE SKIP LOCKED`; keep jobs table shape.
5. Backup: replace `db.backup()` with `pg_dump` in the daily job; zip backup
   embeds the dump instead of the .sqlite file; restore detects which flavor
   a backup zip contains.
6. Data migration: the existing JSON/zip export→restore round trip (batch 2)
   IS the migration tool — export from SQLite instance, restore into pg one.
