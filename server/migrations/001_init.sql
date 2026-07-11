-- Amber schema (Postgres). Single migration: the SQLite v1 schema (design §3)
-- plus everything pulled forward — FTS, title lock, import batch, jobs
-- bookmark_id/progress, content_html — collapsed into one init since there is
-- no pre-existing Postgres data to migrate incrementally.
--
-- Integer 0/1 columns (is_read, title_locked, by_ai) stay INTEGER rather than
-- BOOLEAN so the existing client code (`? 1 : 0`, `=== 1`) is unchanged.

CREATE TABLE bookmarks (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  canonical_url TEXT,
  title         TEXT,
  domain        TEXT,
  favicon_url   TEXT,
  og_image_url  TEXT,
  saved_at      BIGINT NOT NULL,
  content_type  TEXT,
  gist          TEXT,
  summary       TEXT,
  note          TEXT,
  is_read       INTEGER NOT NULL DEFAULT 0,
  saved_from    TEXT,
  device        TEXT,
  referrer      TEXT,
  source_detail TEXT,
  topic_hint    TEXT,
  enrich_status TEXT NOT NULL DEFAULT 'pending',
  fetch_status  TEXT NOT NULL DEFAULT 'pending',
  content_text  TEXT,
  content_html  TEXT,
  archive_ref   TEXT,
  media_ref     TEXT,
  media_status  TEXT,
  title_locked  INTEGER NOT NULL DEFAULT 0,
  import_batch  TEXT,
  -- Full-text index, weighted title(A) > gist/note(B) > content(D). Maintained
  -- automatically as a stored generated column (no triggers). content_text is
  -- truncated into the vector so a 3MB page can't exceed Postgres's 1MB
  -- tsvector limit; the full text is still stored for the reader.
  fts tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(gist, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(note, '')), 'B') ||
    setweight(to_tsvector('simple', left(coalesce(content_text, ''), 600000)), 'D')
  ) STORED
);

CREATE UNIQUE INDEX idx_bookmarks_canonical ON bookmarks(canonical_url) WHERE canonical_url IS NOT NULL;
CREATE INDEX idx_bookmarks_saved_at ON bookmarks(saved_at DESC);
CREATE INDEX idx_bookmarks_enrich_status ON bookmarks(enrich_status);
CREATE INDEX idx_bookmarks_import_batch ON bookmarks(import_batch);
CREATE INDEX idx_bookmarks_content_type ON bookmarks(content_type);
CREATE INDEX idx_bookmarks_fts ON bookmarks USING GIN(fts);

CREATE TABLE topics (
  id    TEXT PRIMARY KEY,
  name  TEXT UNIQUE NOT NULL,
  color TEXT
);

CREATE TABLE bookmark_topics (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  topic_id    TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  by_ai       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (bookmark_id, topic_id)
);

CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  bookmark_id TEXT,
  progress    TEXT
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_bookmark_id ON jobs(bookmark_id);
CREATE INDEX idx_jobs_status_created ON jobs(status, created_at);
