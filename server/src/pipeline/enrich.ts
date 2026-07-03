import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { canonicalize, domainOf } from "../canonical.js";
import { fetchPage } from "./fetcher.js";
import { extractPage } from "./extract.js";
import { enrichWithLLM, type Enrichment } from "./llm.js";
import { isYouTube, fetchOEmbed, enrichYouTubeWithGemini } from "./youtube.js";

function readArchive(dataDir: string, archiveRef: string | null): string | null {
  if (!archiveRef) return null;
  try {
    return fs.readFileSync(path.join(dataDir, archiveRef), "utf8");
  } catch {
    return null;
  }
}

function vocabulary(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM topics").all() as { name: string }[]).map((r) => r.name);
}

function applyTopics(db: Database.Database, bookmarkId: string, names: string[]) {
  const lookup = db.prepare("SELECT id FROM topics WHERE name = ?");
  const insert = db.prepare(
    "INSERT OR IGNORE INTO bookmark_topics (bookmark_id, topic_id, by_ai) VALUES (?, ?, 1)"
  );
  for (const name of names) {
    const topic = lookup.get(name) as { id: string } | undefined;
    if (topic) insert.run(bookmarkId, topic.id);
  }
}

// Idempotent: safe to re-run after a crash mid-way — every step overwrites.
export async function enrichBookmark(
  db: Database.Database,
  config: Config,
  bookmarkId: string
): Promise<void> {
  const bookmark = db.prepare("SELECT * FROM bookmarks WHERE id = ?").get(bookmarkId) as any;
  if (!bookmark) return; // deleted since enqueue — nothing to do

  try {
    await run(db, config, bookmark);
  } catch (err) {
    // Job may still be retried by the queue; a later success overwrites this.
    db.prepare("UPDATE bookmarks SET enrich_status = 'failed' WHERE id = ?").run(bookmarkId);
    throw err;
  }
}

async function run(db: Database.Database, config: Config, bookmark: any): Promise<void> {
  const bookmarkId: string = bookmark.id;
  const topicNames = vocabulary(db);
  let enrichment: Enrichment | null = null;

  if (isYouTube(bookmark.url)) {
    // YouTube branch (design §5): oEmbed for title/channel, Gemini for content.
    const oembed = await fetchOEmbed(bookmark.url);
    if (oembed) {
      db.prepare(
        "UPDATE bookmarks SET title = COALESCE(?, title), og_image_url = ?, fetch_status = 'ok' WHERE id = ?"
      ).run(oembed.title, oembed.thumbnail, bookmarkId);
    } else {
      db.prepare("UPDATE bookmarks SET fetch_status = 'dead' WHERE id = ?").run(bookmarkId);
    }
    if (config.llm.provider === "none") {
      db.prepare(
        "UPDATE bookmarks SET content_type = 'video', enrich_status = 'done' WHERE id = ?"
      ).run(bookmarkId);
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
        `UPDATE bookmarks SET title = ?, favicon_url = COALESCE(favicon_url, ?),
         og_image_url = COALESCE(og_image_url, ?), content_text = ?, fetch_status = 'ok'
         WHERE id = ?`
      ).run(title, extracted.favicon, extracted.image, extracted.text, bookmarkId);
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
          // Duplicate discovered post-redirect: first-seen wins, drop this one.
          db.prepare("DELETE FROM bookmarks WHERE id = ?").run(bookmarkId);
          return;
        }
        db.prepare("UPDATE bookmarks SET canonical_url = ?, domain = ? WHERE id = ?").run(
          finalCanonical,
          domainOf(page.finalUrl),
          bookmarkId
        );
      }

      const extracted = await extractPage(page.html, page.finalUrl);
      title = extracted.title ?? title;
      // Fallback to og:description when extraction yields nothing (SPA, paywall).
      text = extracted.text ?? extracted.description;
      db.prepare(
        `UPDATE bookmarks SET title = ?, favicon_url = ?, og_image_url = ?,
         content_text = ?, fetch_status = 'ok' WHERE id = ?`
      ).run(title, extracted.favicon, extracted.image, extracted.text, bookmarkId);
    } catch {
      // Dead link: keep the bookmark, classify from title/URL alone (design §8).
      db.prepare("UPDATE bookmarks SET fetch_status = 'dead' WHERE id = ?").run(bookmarkId);
    }

    if (config.llm.provider === "none") {
      db.prepare("UPDATE bookmarks SET enrich_status = 'done' WHERE id = ?").run(bookmarkId);
      return;
    }
    enrichment = await enrichWithLLM(config.llm, {
      title,
      url: bookmark.url,
      text,
      topicHint: bookmark.topic_hint,
      topicNames,
    });
  }

  db.prepare(
    "UPDATE bookmarks SET gist = ?, summary = ?, content_type = ?, enrich_status = 'done' WHERE id = ?"
  ).run(enrichment.gist, enrichment.summary, enrichment.content_type, bookmarkId);
  applyTopics(db, bookmarkId, enrichment.topics);
}
