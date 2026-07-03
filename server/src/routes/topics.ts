import { Hono } from "hono";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export function ensureUnsortedTopic(db: Database.Database): string {
  const row = db.prepare("SELECT id FROM topics WHERE name = 'unsorted'").get() as
    | { id: string }
    | undefined;
  if (row) return row.id;
  const id = randomUUID();
  db.prepare("INSERT INTO topics (id, name, color) VALUES (?, 'unsorted', '#999999')").run(id);
  return id;
}

export function topicsForBookmark(db: Database.Database, bookmarkId: string) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.color, bt.by_ai FROM bookmark_topics bt
       JOIN topics t ON t.id = bt.topic_id WHERE bt.bookmark_id = ? ORDER BY t.name`
    )
    .all(bookmarkId);
}

// Replaces a bookmark's topics with the given topic names (user-assigned, by_ai=0).
// Returns names that don't exist in the vocabulary; nothing is written in that case.
export function setBookmarkTopics(
  db: Database.Database,
  bookmarkId: string,
  names: string[]
): string[] {
  const lookup = db.prepare("SELECT id FROM topics WHERE name = ?");
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const row = lookup.get(name) as { id: string } | undefined;
    if (row) ids.push(row.id);
    else unknown.push(name);
  }
  if (unknown.length) return unknown;
  const apply = db.transaction(() => {
    db.prepare("DELETE FROM bookmark_topics WHERE bookmark_id = ?").run(bookmarkId);
    const insert = db.prepare(
      "INSERT INTO bookmark_topics (bookmark_id, topic_id, by_ai) VALUES (?, ?, 0)"
    );
    for (const topicId of ids) insert.run(bookmarkId, topicId);
  });
  apply();
  return [];
}

export function topicRoutes(db: Database.Database): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const rows = db
      .prepare(
        `SELECT t.id, t.name, t.color, COUNT(bt.bookmark_id) AS count
         FROM topics t LEFT JOIN bookmark_topics bt ON bt.topic_id = t.id
         GROUP BY t.id ORDER BY t.name`
      )
      .all();
    return c.json({ topics: rows });
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = body?.name?.trim();
    if (!name) return c.json({ error: "name is required" }, 400);
    const existing = db.prepare("SELECT id FROM topics WHERE name = ?").get(name);
    if (existing) return c.json({ error: "topic already exists" }, 409);
    const id = randomUUID();
    db.prepare("INSERT INTO topics (id, name, color) VALUES (?, ?, ?)").run(
      id,
      name,
      body.color ?? null
    );
    return c.json({ id, name, color: body.color ?? null }, 201);
  });

  // Deleting a topic reassigns its bookmarks to `unsorted` (design §3).
  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    const topic = db.prepare("SELECT id, name FROM topics WHERE id = ?").get(id) as
      | { id: string; name: string }
      | undefined;
    if (!topic) return c.json({ error: "not found" }, 404);
    if (topic.name === "unsorted") return c.json({ error: "cannot delete unsorted" }, 400);
    const unsortedId = ensureUnsortedTopic(db);
    const run = db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO bookmark_topics (bookmark_id, topic_id, by_ai)
         SELECT bookmark_id, ?, by_ai FROM bookmark_topics WHERE topic_id = ?`
      ).run(unsortedId, id);
      db.prepare("DELETE FROM topics WHERE id = ?").run(id);
    });
    run();
    return c.json({ ok: true });
  });

  return app;
}
