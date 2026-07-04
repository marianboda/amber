import { Hono } from "hono";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalize, domainOf } from "../canonical.js";
import { enqueueJob } from "../jobs.js";
import type { Config } from "../config.js";
import { ensureUnsortedTopic, topicsForBookmark, setBookmarkTopics } from "./topics.js";

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

// Reads a request body up to `limit` bytes; returns null once exceeded so the
// caller can 413 without buffering an unbounded upload.
async function readTextLimited(body: ReadableStream | null, limit: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
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

  app.get("/", (c) => {
    const { topic, type, q, read, before, limit } = c.req.query();
    const max = Math.min(Number(limit) || 50, 200);

    const where: string[] = [];
    const params: unknown[] = [];
    if (type) {
      where.push("b.content_type = ?");
      params.push(type);
    }
    if (q) {
      const match = ftsQuery(q);
      if (match) {
        where.push("b.rowid IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ?)");
        params.push(match);
      } else {
        where.push("(b.title LIKE ? OR b.gist LIKE ? OR b.note LIKE ?)");
        const like = `%${q}%`;
        params.push(like, like, like);
      }
    }
    if (read === "0" || read === "1") {
      where.push("b.is_read = ?");
      params.push(Number(read));
    }
    if (before) {
      where.push("b.saved_at < ?");
      params.push(Number(before));
    }
    if (topic) {
      where.push(
        `b.id IN (SELECT bt.bookmark_id FROM bookmark_topics bt
                  JOIN topics t ON t.id = bt.topic_id WHERE t.name = ?)`
      );
      params.push(topic);
    }

    const sql = `SELECT b.* FROM bookmarks b
                 ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY b.saved_at DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, max) as any[];
    for (const row of rows) row.topics = topicsForBookmark(db, row.id);
    return c.json({
      bookmarks: rows,
      next_before: rows.length === max ? rows[rows.length - 1].saved_at : null,
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
      sets.push("title = ?");
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

  app.delete("/:id", (c) => {
    const result = db.prepare("DELETE FROM bookmarks WHERE id = ?").run(c.req.param("id"));
    if (result.changes === 0) return c.json({ error: "not found" }, 404);
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
    // Defense in depth: the capture already blocks scripts, but archives are
    // replayed on this origin, so scrub script vectors server-side too.
    fs.writeFileSync(path.join(dir, `${id}.html`), scrubScripts(html));
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
    return c.body(fs.readFileSync(file));
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
