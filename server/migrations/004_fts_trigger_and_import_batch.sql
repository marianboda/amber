-- (finding 4) The original AFTER UPDATE trigger fired on ANY bookmarks update,
-- so favicon/og_image/canonical writes needlessly re-indexed FTS and grew the
-- WAL. Scope it to the columns FTS actually indexes.
DROP TRIGGER IF EXISTS bookmarks_fts_au;

CREATE TRIGGER bookmarks_fts_au AFTER UPDATE OF title, gist, note, content_text ON bookmarks BEGIN
  INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, gist, note, content_text)
  VALUES ('delete', old.rowid, old.title, old.gist, old.note, old.content_text);
  INSERT INTO bookmarks_fts(rowid, title, gist, note, content_text)
  VALUES (new.rowid, new.title, new.gist, new.note, new.content_text);
END;

-- (finding 5) Distinguish bookmarks by the import job that created them, so
-- import status counts don't conflate two uploads that share a filename.
ALTER TABLE bookmarks ADD COLUMN import_batch TEXT;
