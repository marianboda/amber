import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { canonicalize, domainOf } from "../canonical.js";
import { fetchPage } from "./fetcher.js";
import { extractPage, type ExtractedPage } from "./extract.js";
import { scrubScripts, archivePath } from "../routes/bookmarks.js";
import { enrichWithLLM, type Enrichment } from "./llm.js";
import { isYouTube, fetchOEmbed, enrichYouTubeWithGemini } from "./youtube.js";
import { cacheAssets } from "./assets.js";
import { archiveFallback } from "./archive-fallback.js";

function readArchive(dataDir: string, archiveRef: string | null): string | null {
  if (!archiveRef) return null;
  const file = archivePath(dataDir, archiveRef);
  if (!file) return null;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function vocabulary(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM topics").all() as { name: string }[]).map((r) => r.name);
}

// Reader HTML: scrubbed of scripts like archives (it renders in the web UI's
// sandboxed iframe) and capped so one giant page can't bloat the row.
const MAX_CONTENT_HTML = 2 * 1024 * 1024;
function readerHtml(extracted: ExtractedPage): string | null {
  if (!extracted.contentHtml) return null;
  return scrubScripts(extracted.contentHtml).slice(0, MAX_CONTENT_HTML);
}

// Idempotent: replaces previous AI-assigned topics (re-runs don't accumulate
// stale classifications); user-corrected assignments (by_ai=0) are kept.
export function applyTopics(db: Database.Database, bookmarkId: string, names: string[]) {
  const lookup = db.prepare("SELECT id FROM topics WHERE name = ?");
  const run = db.transaction(() => {
    db.prepare("DELETE FROM bookmark_topics WHERE bookmark_id = ? AND by_ai = 1").run(bookmarkId);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO bookmark_topics (bookmark_id, topic_id, by_ai) VALUES (?, ?, 1)"
    );
    for (const name of names) {
      const topic = lookup.get(name) as { id: string } | undefined;
      if (topic) insert.run(bookmarkId, topic.id);
    }
  });
  run();
}

// Idempotent: safe to re-run after a crash mid-way — every step overwrites.
// mode 'metadata' skips the LLM step (fetch/extract/archive still run), used
// by cheap bulk imports; the LLM pass comes later via /bookmarks/enrich-missing.
export async function enrichBookmark(
  db: Database.Database,
  config: Config,
  bookmarkId: string,
  signal?: AbortSignal,
  mode?: "metadata"
): Promise<void> {
  const bookmark = db.prepare("SELECT * FROM bookmarks WHERE id = ?").get(bookmarkId) as any;
  if (!bookmark) return; // deleted since enqueue — nothing to do

  try {
    await run(db, config, bookmark, signal, mode === "metadata");
  } catch (err) {
    // If the job was aborted (timeout), leave status pending so a clean re-run
    // can redo it — don't stamp 'failed' on a cancellation.
    if (signal?.aborted) throw err;
    // Job may still be retried by the queue; a later success overwrites this.
    db.prepare("UPDATE bookmarks SET enrich_status = 'failed' WHERE id = ?").run(bookmarkId);
    throw err;
  }
}

// Throws if the job was aborted (timeout); called before each terminal DB
// write so a timed-out handler stops mutating instead of racing the retry.
function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("enrichment aborted");
}

async function run(
  db: Database.Database,
  config: Config,
  bookmark: any,
  signal?: AbortSignal,
  skipLLM = false
): Promise<void> {
  const bookmarkId: string = bookmark.id;
  const topicNames = vocabulary(db);
  const metadataOnly = skipLLM || config.llm.provider === "none";
  let enrichment: Enrichment | null = null;

  if (isYouTube(bookmark.url)) {
    // YouTube branch (design §5): oEmbed for title/channel, Gemini for content.
    const oembed = await fetchOEmbed(bookmark.url);
    if (oembed) {
      db.prepare(
        `UPDATE bookmarks SET title = CASE WHEN title_locked = 1 THEN title ELSE COALESCE(?, title) END,
         og_image_url = ?, fetch_status = 'ok' WHERE id = ?`
      ).run(oembed.title, oembed.thumbnail, bookmarkId);
    } else {
      db.prepare("UPDATE bookmarks SET fetch_status = 'dead' WHERE id = ?").run(bookmarkId);
    }
    if (metadataOnly) {
      db.prepare(
        "UPDATE bookmarks SET content_type = 'video', enrich_status = 'done' WHERE id = ?"
      ).run(bookmarkId);
      await cacheAssets(db, config.dataDir, bookmarkId).catch(() => {});
      return;
    }
    enrichment = await enrichYouTubeWithGemini(config, bookmark.url, topicNames);
    if (!enrichment) {
      // No Gemini key: classify from oEmbed metadata via the standard LLM.
      enrichment = await enrichWithLLM(config.llm, {
        title: oembed?.title ?? bookmark.title,
        url: bookmark.url,
        text: oembed?.channel ? `YouTube video by ${oembed.channel}` : null,
        topicHint: bookmark.topic_hint,
        topicNames,
      });
      enrichment.content_type = "video";
    }
  } else {
    let title: string | null = bookmark.title;
    let text: string | null = null;
    const archived = readArchive(config.dataDir, bookmark.archive_ref);
    if (archived) {
      // Client-captured snapshot wins: it's what the user actually saw,
      // works for auth-walled pages, and needs no network.
      const extracted = await extractPage(archived, bookmark.url);
      title = extracted.title ?? title;
      text = extracted.text ?? extracted.description;
      db.prepare(
        `UPDATE bookmarks SET
           title = CASE WHEN title_locked = 1 THEN title ELSE ? END,
           favicon_url = COALESCE(favicon_url, ?),
           og_image_url = COALESCE(og_image_url, ?), content_text = ?, content_html = ?,
           fetch_status = 'ok'
         WHERE id = ?`
      ).run(title, extracted.favicon, extracted.image, extracted.text, readerHtml(extracted), bookmarkId);
    } else
    try {
      const page = await fetchPage(bookmark.url);

      // Network-level canonicalization: the final redirect target wins.
      const finalCanonical = canonicalize(page.finalUrl);
      if (finalCanonical !== bookmark.canonical_url) {
        const owner = db
          .prepare("SELECT id FROM bookmarks WHERE canonical_url = ? AND id != ?")
          .get(finalCanonical, bookmarkId) as { id: string } | undefined;
        if (owner) {
          // Duplicate discovered post-redirect: first-seen wins, but carry all
          // of the new save's user data over so nothing is silently dropped.
          const merge = db.transaction(() => {
            if (bookmark.note) {
              db.prepare(
                `UPDATE bookmarks SET note = CASE
                   WHEN note IS NULL OR note = '' THEN ?
                   ELSE note || char(10) || char(10) || ?
                 END WHERE id = ?`
              ).run(bookmark.note, bookmark.note, owner.id);
            }
            if (bookmark.is_read) {
              db.prepare("UPDATE bookmarks SET is_read = 1 WHERE id = ?").run(owner.id);
            }
            if (bookmark.title) {
              db.prepare(
                "UPDATE bookmarks SET title = COALESCE(NULLIF(title, ''), ?) WHERE id = ?"
              ).run(bookmark.title, owner.id);
            }
            // Move any user-assigned topics from the doomed row to the survivor.
            db.prepare(
              `INSERT OR IGNORE INTO bookmark_topics (bookmark_id, topic_id, by_ai)
               SELECT ?, topic_id, by_ai FROM bookmark_topics WHERE bookmark_id = ? AND by_ai = 0`
            ).run(owner.id, bookmarkId);
            db.prepare("DELETE FROM bookmarks WHERE id = ?").run(bookmarkId);
          });
          merge();
          return;
        }
        db.prepare("UPDATE bookmarks SET canonical_url = ?, domain = ? WHERE id = ?").run(
          finalCanonical,
          domainOf(page.finalUrl),
          bookmarkId
        );
      }

      if (!page.isHtml) {
        // PDF/image/binary: no markup to extract or archive — keep the
        // bookmark, classify from title/URL alone, don't pollute FTS.
        db.prepare("UPDATE bookmarks SET fetch_status = 'ok' WHERE id = ?").run(bookmarkId);
      } else {
        const extracted = await extractPage(page.html, page.finalUrl);
        title = extracted.title ?? title;
        // Fallback to og:description when extraction yields nothing (SPA, paywall).
        text = extracted.text ?? extracted.description;
        db.prepare(
          `UPDATE bookmarks SET
             title = CASE WHEN title_locked = 1 THEN title ELSE ? END,
             favicon_url = ?, og_image_url = ?,
             content_text = ?, content_html = ?, fetch_status = 'ok' WHERE id = ?`
        ).run(title, extracted.favicon, extracted.image, extracted.text, readerHtml(extracted), bookmarkId);
        // Non-extension saves get an archive of what was fetched. It swallows
        // its own errors (returns false) so a write failure here never gets
        // misclassified as a dead link by the catch below.
        await archiveFallback(db, config.dataDir, bookmarkId, page.finalUrl, page.html);
      }
    } catch (err) {
      if (signal?.aborted) throw err; // don't mark a cancelled fetch as dead
      // Dead link: keep the bookmark, classify from title/URL alone (design §8).
      db.prepare("UPDATE bookmarks SET fetch_status = 'dead' WHERE id = ?").run(bookmarkId);
    }

    if (metadataOnly) {
      db.prepare("UPDATE bookmarks SET enrich_status = 'done' WHERE id = ?").run(bookmarkId);
      await cacheAssets(db, config.dataDir, bookmarkId).catch(() => {});
      return;
    }
    checkAborted(signal);
    enrichment = await enrichWithLLM(config.llm, {
      title,
      url: bookmark.url,
      text,
      topicHint: bookmark.topic_hint,
      topicNames,
    });
  }

  checkAborted(signal);
  db.prepare(
    "UPDATE bookmarks SET gist = ?, summary = ?, content_type = ?, enrich_status = 'done' WHERE id = ?"
  ).run(enrichment.gist, enrichment.summary, enrichment.content_type, bookmarkId);
  applyTopics(db, bookmarkId, enrichment.topics);
  // Cache thumbnails/favicons locally so cards survive link rot (best-effort).
  await cacheAssets(db, config.dataDir, bookmarkId).catch(() => {});
}
