-- Sanitized reader HTML from extraction (Defuddle content, scripts scrubbed).
-- Rendered by the web reader in a sandboxed iframe; content_text stays the
-- FTS-indexed plain text. Deliberately NOT added to the FTS triggers.
ALTER TABLE bookmarks ADD COLUMN content_html TEXT;
