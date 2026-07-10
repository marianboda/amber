import { Hono } from "hono";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { canonicalize, domainOf } from "../canonical.js";
import { enqueueJob } from "../jobs.js";
import { readTextLimited } from "../http-util.js";
import type { Config } from "../config.js";
import {
  ensureUnsortedTopic,
  topicsForBookmark,
  topicsForBookmarks,
  setBookmarkTopics,
} from "./topics.js";

const SAVED_FROM = new Set(["extension", "share_sheet", "context_menu", "import", "api"]);

// Every whitespace-separated term becomes a quoted prefix token, ANDed:
// `rust async` → `"rust"* "async"*`. Quoting neutralizes FTS5 operator syntax.
export function ftsQuery(q: string): string | null {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(" ");
}

export function scrubScripts(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*/gi, "$1=$2#");
}

export function bookmarkRoutes(db: Database.Database, config: Config): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.url || typeof body.url !== "string") {
      return c.json({ error: "url is required" }, 400);
    }
    let canonical: string;
    let domain: string;
    try {
      canonical = canonicalize(body.url);
      domain = domainOf(body.url);
    } catch {
      return c.json({ error: "invalid url" }, 400);
    }
    const savedFrom = SAVED_FROM.has(body.saved_from) ? body.saved_from : "api";

    const existing = db
      .prepare("SELECT id, saved_at FROM bookmarks WHERE canonical_url = ?")
      .get(canonical) as { id: string; saved_at: number } | undefined;
    if (existing) {
      return c.json({ id: existing.id, duplicate: true, saved_at: existing.saved_at }, 200);
    }

    const id = randomUUID();
    // archive_coming: the client will PUT a page snapshot right after this
    // save; defer enrichment to that upload instead of running it twice.
    // A periodic sweep re-enqueues the job if the snapshot never arrives.
    const deferEnrich = body.archive_coming === true;
    const savedAt =
      typeof body.saved_at === "number" ? body.saved_at : Math.floor(Date.now() / 1000);
    try {
      db.prepare(
        `INSERT INTO bookmarks
           (id, url, canonical_url, title, domain, saved_at, note,
            saved_from, device, referrer, source_detail, topic_hint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        body.url,
        canonical,
        body.title ?? null,
        domain,
        savedAt,
        body.note ?? null,
        savedFrom,
        body.device ?? null,
        body.referrer ?? null,
        body.source_detail ?? null,
        body.topic_hint ?? null
      );
    } catch (err: any) {
      // Concurrent save of the same URL lost the race on the unique index —
      // return the winner as a duplicate instead of a 500.
      if (String(err?.code).startsWith("SQLITE_CONSTRAINT")) {
        const winner = db
          .prepare("SELECT id, saved_at FROM bookmarks WHERE canonical_url = ?")
          .get(canonical) as { id: string; saved_at: number } | undefined;
        if (winner) return c.json({ id: winner.id, duplicate: true, saved_at: winner.saved_at }, 200);
      }
      throw err;
    }
    if (!deferEnrich) enqueueJob(db, "enrich", { bookmark_id: id });
    return c.json({ id }, 201);
  });

  // Batched enrichment status for the UI's pending-card poll — one request
  // for a whole screenful instead of 20 sequential GETs every 2s.
  app.get("/status", (c) => {
    const ids = (c.req.query("ids") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);
    if (!ids.length) return c.json({ statuses: [] });
    const rows = db
      .prepare(
        `SELECT id, enrich_status, fetch_status, gist FROM bookmarks
         WHERE id IN (${ids.map(() => "?").join(",")})`
      )
      .all(...ids);
    return c.json({ statuses: rows });
  });

  app.get("/", (c) => {
    const { topic, type, q, read, before, after, domain, sort, limit } = c.req.query();
    // Clamp to [1, 200]; invalid/≤0 falls back to 50 (a raw negative would
    // become SQLite LIMIT -1 = unbounded and could scan the whole library).
    const requested = Math.trunc(Number(limit));
    const max = Math.min(requested >= 1 ? requested : 50, 200);
    const oldest = sort === "oldest";

    const where: string[] = [];
    const params: unknown[] = [];
    if (type) {
      where.push("b.content_type = ?");
      params.push(type);
    }
    if (domain) {
      where.push("b.domain = ?");
      params.push(domain);
    }
    // Search defaults to bm25 relevance (title > gist/note > content_text) with
    // match snippets; sort=recent/oldest opts back into date order + cursor.
    const match = q ? ftsQuery(q) : null;
    const relevance = !!match && !oldest && sort !== "recent";
    if (q && match && !relevance) {
      where.push("b.rowid IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ?)");
      params.push(match);
    } else if (q && !match) {
      where.push("(b.title LIKE ? OR b.gist LIKE ? OR b.note LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (read === "0" || read === "1") {
      where.push("b.is_read = ?");
      params.push(Number(read));
    }
    // Stable cursor "savedAt.id": rows with an identical saved_at (common
    // after an import that shares one ADD_DATE) are no longer skipped.
    // `before` pages newest-first, `after` pages oldest-first (sort=oldest).
    const cursor = oldest ? after : before;
    if (cursor) {
      const dot = String(cursor).lastIndexOf(".");
      const cursorSaved = Number(dot > 0 ? cursor.slice(0, dot) : cursor);
      const cursorId = dot > 0 ? cursor.slice(dot + 1) : "";
      const [cmp] = oldest ? [">"] : ["<"];
      if (cursorId) {
        where.push(
          `(b.saved_at ${cmp} ? OR (b.saved_at = ? AND b.id ${cmp} ?))`
        );
        params.push(cursorSaved, cursorSaved, cursorId);
      } else {
        where.push(`b.saved_at ${cmp} ?`);
        params.push(cursorSaved);
      }
    }
    if (topic) {
      where.push(
        `b.id IN (SELECT bt.bookmark_id FROM bookmark_topics bt
                  JOIN topics t ON t.id = bt.topic_id WHERE t.name = ?)`
      );
      params.push(topic);
    }

    // Everything except content_text, which can be hundreds of KB per row and
    // is only needed by the detail view (GET /:id returns the full row).
    const cardColumns =
      `b.id, b.url, b.canonical_url, b.title, b.domain, b.favicon_url, b.og_image_url,
       b.saved_at, b.content_type, b.gist, b.summary, b.note, b.is_read, b.saved_from,
       b.device, b.referrer, b.source_detail, b.topic_hint, b.enrich_status,
       b.fetch_status, b.archive_ref, b.media_ref, b.media_status, b.title_locked,
       b.import_batch`;
    let rows: any[];
    if (relevance) {
      // Best hits first; a common term over 100k rows would bury the right one
      // under recency. No cursor — relevance beyond ~200 rows isn't navigation.
      const sql = `SELECT ${cardColumns}, f.snip AS snippet FROM bookmarks b
                   JOIN (SELECT rowid,
                                bm25(bookmarks_fts, 10.0, 5.0, 5.0, 1.0) AS rank,
                                snippet(bookmarks_fts, 3, '<mark>', '</mark>', ' … ', 12) AS snip
                         FROM bookmarks_fts WHERE bookmarks_fts MATCH ?) f ON f.rowid = b.rowid
                   ${where.length ? "WHERE " + where.join(" AND ") : ""}
                   ORDER BY f.rank LIMIT ?`;
      rows = db.prepare(sql).all(match, ...params, max) as any[];
    } else {
      const order = oldest ? "ASC" : "DESC";
      const sql = `SELECT ${cardColumns} FROM bookmarks b
                   ${where.length ? "WHERE " + where.join(" AND ") : ""}
                   ORDER BY b.saved_at ${order}, b.id ${order} LIMIT ?`;
      rows = db.prepare(sql).all(...params, max) as any[];
    }
    const topicMap = topicsForBookmarks(db, rows.map((r) => r.id));
    for (const row of rows) row.topics = topicMap.get(row.id) ?? [];
    const last = rows[rows.length - 1];
    const next = !relevance && rows.length === max ? `${last.saved_at}.${last.id}` : null;
    return c.json({
      bookmarks: rows,
      next_before: oldest || relevance ? null : next,
      next_after: oldest ? next : null,
    });
  });

  app.get("/:id", (c) => {
    const row = db.prepare("SELECT * FROM bookmarks WHERE id = ?").get(c.req.param("id")) as any;
    if (!row) return c.json({ error: "not found" }, 404);
    row.topics = topicsForBookmark(db, row.id);
    return c.json(row);
  });

  app.get("/:id/status", (c) => {
    const row = db
      .prepare("SELECT id, enrich_status, fetch_status, gist FROM bookmarks WHERE id = ?")
      .get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const exists = db.prepare("SELECT id FROM bookmarks WHERE id = ?").get(id);
    if (!exists) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid body" }, 400);

    // Validate topics BEFORE any write so a bad topic list can't leave a
    // half-applied patch behind.
    if (Array.isArray(body.topics)) {
      const known = db.prepare("SELECT name FROM topics").all() as { name: string }[];
      const vocab = new Set(known.map((t) => t.name));
      const unknown = body.topics.filter((t: string) => !vocab.has(t));
      if (unknown.length) return c.json({ error: "unknown topics", topics: unknown }, 400);
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if ("note" in body) {
      sets.push("note = ?");
      params.push(body.note);
    }
    if ("title" in body) {
      // Lock the title so later enrichment never clobbers a user edit.
      sets.push("title = ?", "title_locked = 1");
      params.push(body.title);
    }
    if ("is_read" in body) {
      sets.push("is_read = ?");
      params.push(body.is_read ? 1 : 0);
    }
    const apply = db.transaction(() => {
      if (sets.length) {
        db.prepare(`UPDATE bookmarks SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
      }
      if (Array.isArray(body.topics)) setBookmarkTopics(db, id, body.topics);
    });
    apply();
    const row = db.prepare("SELECT * FROM bookmarks WHERE id = ?").get(id) as any;
    row.topics = topicsForBookmark(db, id);
    return c.json(row);
  });

  // Delete is soft: the row (with topics) and its per-bookmark files move to
  // trash/, purged after 30 days by maintenance — a mis-click in a permanent
  // library must be recoverable, and archives must not leak disk forever.
  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    const row = db.prepare("SELECT * FROM bookmarks WHERE id = ?").get(id) as any;
    if (!row) return c.json({ error: "not found" }, 404);
    row.topics = topicsForBookmark(db, id);

    const trashDir = path.join(config.dataDir, "trash");
    fs.mkdirSync(trashDir, { recursive: true });
    fs.writeFileSync(
      path.join(trashDir, `${id}.json`),
      JSON.stringify({ deleted_at: Math.floor(Date.now() / 1000), bookmark: row }, null, 2)
    );
    // Archive + cached thumb are keyed by bookmark id; favicons are shared by
    // domain and stay. Move (don't delete) so restore-from-trash keeps them.
    if (row.archive_ref) {
      const file = path.join(config.dataDir, row.archive_ref);
      if (fs.existsSync(file)) fs.renameSync(file, path.join(trashDir, path.basename(file)));
    }
    if (row.og_image_url?.startsWith("/assets/thumbs/")) {
      const file = path.join(config.dataDir, "assets", "thumbs", path.basename(row.og_image_url));
      if (fs.existsSync(file)) fs.renameSync(file, path.join(trashDir, path.basename(file)));
    }

    db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
    return c.json({ ok: true });
  });

  // Client-captured page snapshot (self-contained HTML from the extension).
  // Solves auth-walled and short-lived URLs: the server stores what the user's
  // logged-in tab actually rendered, then re-extracts from that copy.
  app.put("/:id/archive", async (c) => {
    const id = c.req.param("id");
    const row = db.prepare("SELECT id, archive_ref FROM bookmarks WHERE id = ?").get(id) as
      | { id: string; archive_ref: string | null }
      | undefined;
    if (!row) return c.json({ error: "not found" }, 404);
    // Permanence: the first snapshot is the preserved one — never overwritten.
    // (?replace=1 exists as a deliberate escape hatch.)
    if (
      row.archive_ref &&
      fs.existsSync(path.join(config.dataDir, row.archive_ref)) &&
      c.req.query("replace") !== "1"
    ) {
      return c.json({ ok: true, kept_existing: true });
    }
    const MAX_ARCHIVE = 300 * 1024 * 1024;
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_ARCHIVE) return c.json({ error: "archive too large (300MB max)" }, 413);
    const html = await readTextLimited(c.req.raw.body, MAX_ARCHIVE);
    if (html === null) return c.json({ error: "archive too large (300MB max)" }, 413);
    if (!html || html.length < 100) return c.json({ error: "empty archive" }, 400);
    const dir = path.join(config.dataDir, "archives");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.html`);
    const replace = c.req.query("replace") === "1";
    // Atomic first-write claim: 'wx' fails if the file exists, so two
    // concurrent first uploads can't both overwrite the preserved snapshot.
    try {
      fs.writeFileSync(file, scrubScripts(html), { flag: replace ? "w" : "wx" });
    } catch (err: any) {
      if (err?.code === "EEXIST") return c.json({ ok: true, kept_existing: true });
      throw err;
    }
    db.prepare(
      "UPDATE bookmarks SET archive_ref = ?, fetch_status = 'ok', enrich_status = 'pending' WHERE id = ?"
    ).run(`archives/${id}.html`, id);
    enqueueJob(db, "enrich", { bookmark_id: id }); // re-extract from the snapshot
    return c.json({ ok: true, bytes: html.length });
  });

  app.get("/:id/archive", (c) => {
    const row = db.prepare("SELECT archive_ref FROM bookmarks WHERE id = ?").get(c.req.param("id")) as
      | { archive_ref: string | null }
      | undefined;
    if (!row?.archive_ref) return c.json({ error: "no archive" }, 404);
    const file = path.join(config.dataDir, row.archive_ref);
    if (!fs.existsSync(file)) return c.json({ error: "archive file missing" }, 404);
    c.header("Content-Type", "text/html; charset=utf-8");
    // No script execution even if something slipped through the scrubs.
    c.header("Content-Security-Policy", "sandbox; script-src 'none'");
    // Streamed: archives run to 300MB and readFileSync would block the loop.
    return c.body(Readable.toWeb(fs.createReadStream(file)) as ReadableStream);
  });

  // Enqueue LLM enrichment for rows that completed metadata-only (imported
  // with enrich=metadata, or enriched while no LLM key was configured).
  // Batched by limit so a 20k backlog can be worked in controlled chunks.
  app.post("/enrich-missing", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const requested = Math.trunc(Number(body?.limit));
    const limit = Math.min(requested >= 1 ? requested : 500, 5000);
    const rows = db
      .prepare(
        `SELECT id FROM bookmarks WHERE enrich_status = 'done' AND gist IS NULL
         ORDER BY saved_at DESC LIMIT ?`
      )
      .all(limit) as { id: string }[];
    const enqueue = db.transaction(() => {
      for (const { id } of rows) {
        db.prepare("UPDATE bookmarks SET enrich_status = 'pending' WHERE id = ?").run(id);
        enqueueJob(db, "enrich", { bookmark_id: id });
      }
    });
    enqueue();
    const remaining = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM bookmarks WHERE enrich_status = 'done' AND gist IS NULL"
        )
        .get() as { n: number }
    ).n;
    return c.json({ enqueued: rows.length, remaining });
  });

  // Re-enqueue every failed enrichment in one shot.
  app.post("/retry-failed", (c) => {
    const failed = db
      .prepare("SELECT id FROM bookmarks WHERE enrich_status = 'failed'")
      .all() as { id: string }[];
    for (const { id } of failed) {
      db.prepare("UPDATE bookmarks SET enrich_status = 'pending' WHERE id = ?").run(id);
      enqueueJob(db, "enrich", { bookmark_id: id });
    }
    return c.json({ retried: failed.length });
  });

  app.post("/:id/retry", (c) => {
    const id = c.req.param("id");
    const row = db.prepare("SELECT enrich_status FROM bookmarks WHERE id = ?").get(id) as
      | { enrich_status: string }
      | undefined;
    if (!row) return c.json({ error: "not found" }, 404);
    db.prepare("UPDATE bookmarks SET enrich_status = 'pending' WHERE id = ?").run(id);
    enqueueJob(db, "enrich", { bookmark_id: id });
    return c.json({ ok: true });
  });

  return app;
}

export { ensureUnsortedTopic };
