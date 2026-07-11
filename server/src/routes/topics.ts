import { Hono } from "hono";
import type { Db, Queryable } from "../db.js";
import { randomUUID } from "node:crypto";

export async function ensureUnsortedTopic(db: Queryable): Promise<string> {
  const row = (await db.prepare("SELECT id FROM topics WHERE name = 'unsorted'").get()) as
    | { id: string }
    | undefined;
  if (row) return row.id;
  const id = randomUUID();
  await db.prepare("INSERT INTO topics (id, name, color) VALUES (?, 'unsorted', '#999999')").run(id);
  return id;
}

export function topicsForBookmark(db: Queryable, bookmarkId: string) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.color, bt.by_ai FROM bookmark_topics bt
       JOIN topics t ON t.id = bt.topic_id WHERE bt.bookmark_id = ? ORDER BY t.name`
    )
    .all(bookmarkId);
}

// Batch variant for list/export paths — one query per 500 ids instead of one
// per bookmark. Every requested id gets an entry (empty array when untagged).
export async function topicsForBookmarks(
  db: Queryable,
  ids: string[]
): Promise<Map<string, { id: string; name: string; color: string | null; by_ai: number }[]>> {
  const map = new Map(ids.map((id) => [id, [] as any[]]));
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = (await db
      .prepare(
        `SELECT bt.bookmark_id, t.id, t.name, t.color, bt.by_ai FROM bookmark_topics bt
         JOIN topics t ON t.id = bt.topic_id
         WHERE bt.bookmark_id IN (${chunk.map(() => "?").join(",")}) ORDER BY t.name`
      )
      .all(...chunk)) as any[];
    for (const { bookmark_id, ...topic } of rows) map.get(bookmark_id)?.push(topic);
  }
  return map;
}

// Replaces a bookmark's topics with the given topic names (user-assigned, by_ai=0).
// Returns names that don't exist in the vocabulary; nothing is written in that case.
export async function setBookmarkTopics(
  db: Db,
  bookmarkId: string,
  names: string[]
): Promise<string[]> {
  const lookup = db.prepare("SELECT id FROM topics WHERE name = ?");
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const row = (await lookup.get(name)) as { id: string } | undefined;
    if (row) ids.push(row.id);
    else unknown.push(name);
  }
  if (unknown.length) return unknown;
  await db.tx(async (t) => {
    await t.prepare("DELETE FROM bookmark_topics WHERE bookmark_id = ?").run(bookmarkId);
    const insert = t.prepare(
      "INSERT INTO bookmark_topics (bookmark_id, topic_id, by_ai) VALUES (?, ?, 0)"
    );
    for (const topicId of ids) await insert.run(bookmarkId, topicId);
  });
  return [];
}

export function topicRoutes(db: Db): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const rows = await db
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
    const existing = await db.prepare("SELECT id FROM topics WHERE name = ?").get(name);
    if (existing) return c.json({ error: "topic already exists" }, 409);
    const id = randomUUID();
    await db
      .prepare("INSERT INTO topics (id, name, color) VALUES (?, ?, ?)")
      .run(id, name, body.color ?? null);
    return c.json({ id, name, color: body.color ?? null }, 201);
  });

  // Deleting a topic reassigns its bookmarks to `unsorted` (design §3).
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const topic = (await db.prepare("SELECT id, name FROM topics WHERE id = ?").get(id)) as
      | { id: string; name: string }
      | undefined;
    if (!topic) return c.json({ error: "not found" }, 404);
    if (topic.name === "unsorted") return c.json({ error: "cannot delete unsorted" }, 400);
    const unsortedId = await ensureUnsortedTopic(db);
    await db.tx(async (t) => {
      await t
        .prepare(
          `INSERT INTO bookmark_topics (bookmark_id, topic_id, by_ai)
           SELECT bookmark_id, ?, by_ai FROM bookmark_topics WHERE topic_id = ?
           ON CONFLICT DO NOTHING`
        )
        .run(unsortedId, id);
      await t.prepare("DELETE FROM topics WHERE id = ?").run(id);
    });
    return c.json({ ok: true });
  });

  return app;
}
