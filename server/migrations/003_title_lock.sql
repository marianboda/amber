-- Guards a user-edited title from being overwritten by a later enrichment run.
ALTER TABLE bookmarks ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;
