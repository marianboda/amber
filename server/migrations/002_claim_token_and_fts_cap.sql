-- Ownership token for job claims: finish/requeue only touch the row if it's
-- still claimed by the same worker run, so a timed-out/reclaimed job's original
-- execution can't overwrite the state of its retry (or another instance's).
ALTER TABLE jobs ADD COLUMN claimed_by TEXT;

-- The FTS generated column truncated content by CHARACTERS (600k). A tsvector
-- must stay under Postgres's ~1MB limit, and 600k chars of multibyte/diverse
-- text can blow past it — which would fail the INSERT/UPDATE and abort
-- enrichment. Regenerate with a much safer 200k-char cap (title/gist/note are
-- always indexed; only very long bodies lose their tail from search).
DROP INDEX IF EXISTS idx_bookmarks_fts;
ALTER TABLE bookmarks DROP COLUMN fts;
ALTER TABLE bookmarks ADD COLUMN fts tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(gist, '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(note, '')), 'B') ||
  setweight(to_tsvector('simple', left(coalesce(content_text, ''), 200000)), 'D')
) STORED;
CREATE INDEX idx_bookmarks_fts ON bookmarks USING GIN(fts);
