-- Direct bookmark linkage on jobs replaces the O(pending × jobs) LIKE scan in
-- the maintenance orphan sweep, and import progress moves to its own column so
-- runImport no longer rewrites its whole item list on every chunk.
ALTER TABLE jobs ADD COLUMN bookmark_id TEXT;
ALTER TABLE jobs ADD COLUMN progress TEXT;
UPDATE jobs SET bookmark_id = json_extract(payload, '$.bookmark_id')
 WHERE type = 'enrich';

CREATE INDEX idx_jobs_bookmark_id ON jobs(bookmark_id);
CREATE INDEX idx_jobs_status_created ON jobs(status, created_at);

-- Columns the maintenance sweep, retry-failed, and import status hit on every run.
CREATE INDEX idx_bookmarks_enrich_status ON bookmarks(enrich_status);
CREATE INDEX idx_bookmarks_import_batch ON bookmarks(import_batch);
CREATE INDEX idx_bookmarks_content_type ON bookmarks(content_type);
