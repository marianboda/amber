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
  is_read       INTEGER DEFAULT 0,          -- quiet flag; no counts, no badges
  -- provenance
  saved_from    TEXT,                       -- extension|share_sheet|context_menu|import|api
  device        TEXT,                       -- hostname / device name
  referrer      TEXT,                       -- page where the link was found
  source_detail TEXT,                       -- e.g. "chrome-export", source app name
  topic_hint    TEXT,                       -- import folder path, classification hint
  -- pipeline
  enrich_status TEXT DEFAULT 'pending',     -- pending|done|failed
  fetch_status  TEXT DEFAULT 'pending',     -- pending|ok|dead
  -- v2 fields, in schema from day one
  content_text  TEXT,
  archive_ref   TEXT,
  media_ref     TEXT,
  media_status  TEXT
);

CREATE INDEX idx_bookmarks_saved_at ON bookmarks(saved_at DESC);
CREATE UNIQUE INDEX idx_bookmarks_canonical ON bookmarks(canonical_url) WHERE canonical_url IS NOT NULL;

CREATE TABLE topics (
  id    TEXT PRIMARY KEY,
  name  TEXT UNIQUE NOT NULL,               -- closed vocabulary, user-curated
  color TEXT
);

CREATE TABLE bookmark_topics (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  topic_id    TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  by_ai       INTEGER DEFAULT 1,            -- 1=AI-assigned, 0=user-assigned/corrected
  PRIMARY KEY (bookmark_id, topic_id)
);

CREATE TABLE jobs (
  id         TEXT PRIMARY KEY,              -- uuid
  type       TEXT NOT NULL,                 -- enrich|import|classify
  payload    TEXT NOT NULL,                 -- JSON
  status     TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_jobs_status ON jobs(status);
