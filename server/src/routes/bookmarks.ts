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
    const savedAt =
      typeof body.saved_at === "number" ? body.saved_at : Math.floor(Date.now() / 1000);
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
    enqueueJob(db, "enrich", { bookmark_id: id });
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
      where.push("(b.title LIKE ? OR b.gist LIKE ? OR b.note LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like);
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
    if (sets.length) {
      db.prepare(`UPDATE bookmarks SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    }
    if (Array.isArray(body.topics)) {
      const unknown = setBookmarkTopics(db, id, body.topics);
      if (unknown.length) return c.json({ error: "unknown topics", topics: unknown }, 400);
    }
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
    const exists = db.prepare("SELECT id FROM bookmarks WHERE id = ?").get(id);
    if (!exists) return c.json({ error: "not found" }, 404);
    const html = await c.req.text();
    if (!html || html.length < 100) return c.json({ error: "empty archive" }, 400);
    const dir = path.join(config.dataDir, "archives");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.html`), html);
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
    return c.body(fs.readFileSync(file));
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
