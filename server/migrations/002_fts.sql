-- Full-text search over everything ever saved (v2 "Find" milestone).
-- External-content FTS5 table kept in sync with bookmarks via triggers.
CREATE VIRTUAL TABLE bookmarks_fts USING fts5(
  title, gist, note, content_text,
  content='bookmarks', content_rowid='rowid'
);

CREATE TRIGGER bookmarks_fts_ai AFTER INSERT ON bookmarks BEGIN
  INSERT INTO bookmarks_fts(rowid, title, gist, note, content_text)
  VALUES (new.rowid, new.title, new.gist, new.note, new.content_text);
END;

CREATE TRIGGER bookmarks_fts_ad AFTER DELETE ON bookmarks BEGIN
  INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, gist, note, content_text)
  VALUES ('delete', old.rowid, old.title, old.gist, old.note, old.content_text);
END;

CREATE TRIGGER bookmarks_fts_au AFTER UPDATE ON bookmarks BEGIN
  INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, gist, note, content_text)
  VALUES ('delete', old.rowid, old.title, old.gist, old.note, old.content_text);
  INSERT INTO bookmarks_fts(rowid, title, gist, note, content_text)
  VALUES (new.rowid, new.title, new.gist, new.note, new.content_text);
END;

INSERT INTO bookmarks_fts(bookmarks_fts) VALUES ('rebuild');
