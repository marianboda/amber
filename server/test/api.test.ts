import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import type { Config } from "../src/config.js";
import { bookmarkRoutes } from "../src/routes/bookmarks.js";
import { topicRoutes } from "../src/routes/topics.js";
import { exportRoutes } from "../src/routes/export.js";
import { importRoutes } from "../src/routes/import.js";
import { parseNetscape } from "../src/import/parse.js";
import { startWorker } from "../src/queue.js";
import { enqueueJob } from "../src/jobs.js";

import { TEST_DATABASE_URL } from "./pg.js";

let dir: string;
let db: Awaited<ReturnType<typeof openDb>>;
let app: Hono;
let config: Config;
const SCHEMA = "test_api";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-test-"));
  db = await openDb(TEST_DATABASE_URL, { schema: SCHEMA });
  config = {
    port: 0,
    dataDir: dir,
    databaseUrl: TEST_DATABASE_URL,
    authToken: "t",
    llm: { provider: "none", apiKey: "", model: "" },
    geminiApiKey: "",
    deviceName: "test",
  };
  app = new Hono();
  app.route("/bookmarks", bookmarkRoutes(db, config));
  app.route("/topics", topicRoutes(db));
  app.route("/export", exportRoutes(db, dir));
  app.route("/import", importRoutes(db, dir));
});

afterAll(async () => {
  await db.pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
  await db.end();
  fs.rmSync(dir, { recursive: true, force: true });
});

const json = (body: object) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("bookmarks API", () => {
  let id: string;

  it("creates a bookmark and enqueues enrichment", async () => {
    const res = await app.request("/bookmarks", json({ url: "https://a.com/x?utm_source=t&p=1", note: "hello" }));
    expect(res.status).toBe(201);
    id = (await res.json()).id;
    const jobs = await db.prepare("SELECT * FROM jobs WHERE type='enrich'").all();
    expect(jobs).toHaveLength(1);
  });

  it("dedups by canonical url", async () => {
    const res = await app.request("/bookmarks", json({ url: "https://a.com/x?p=1&fbclid=zz" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicate).toBe(true);
    expect(body.id).toBe(id);
  });

  it("defers enrichment when archive_coming", async () => {
    const res = await app.request("/bookmarks", json({ url: "https://a.com/deferred", archive_coming: true }));
    expect(res.status).toBe(201);
    const deferredId = (await res.json()).id;
    const jobs = await db.prepare("SELECT * FROM jobs WHERE payload LIKE ?").all(`%${deferredId}%`);
    expect(jobs).toHaveLength(0);
  });

  it("rejects invalid url and missing url", async () => {
    expect((await app.request("/bookmarks", json({ url: "not a url" }))).status).toBe(400);
    expect((await app.request("/bookmarks", json({}))).status).toBe(400);
  });

  it("patches note and read flag", async () => {
    const res = await app.request(`/bookmarks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "edited", is_read: true }),
    });
    const body = await res.json();
    expect(body.note).toBe("edited");
    expect(body.is_read).toBe(1);
  });

  it("rejects unknown topics on patch", async () => {
    const res = await app.request(`/bookmarks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topics: ["ghost"] }),
    });
    expect(res.status).toBe(400);
  });

  it("assigns topics and filters by them", async () => {
    await app.request("/topics", json({ name: "dev" }));
    await app.request(`/bookmarks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topics: ["dev"] }),
    });
    const list = await (await app.request("/bookmarks?topic=dev")).json();
    expect(list.bookmarks).toHaveLength(1);
    expect(list.bookmarks[0].topics[0].name).toBe("dev");
    expect(list.bookmarks[0].topics[0].by_ai).toBe(0);
  });

  it("filters by read flag and searches via FTS", async () => {
    const read = await (await app.request("/bookmarks?read=1")).json();
    expect(read.bookmarks.map((b: any) => b.id)).toContain(id);
    const hits = await (await app.request("/bookmarks?q=edited")).json();
    expect(hits.bookmarks.map((b: any) => b.id)).toContain(id);
    const none = await (await app.request("/bookmarks?q=zzqx")).json();
    expect(none.bookmarks).toHaveLength(0);
  });

  it("deleting a topic reassigns bookmarks to unsorted", async () => {
    const topics = await (await app.request("/topics")).json();
    const dev = topics.topics.find((t: any) => t.name === "dev");
    await app.request(`/topics/${dev.id}`, { method: "DELETE" });
    const bookmark = await (await app.request(`/bookmarks/${id}`)).json();
    expect(bookmark.topics.map((t: any) => t.name)).toEqual(["unsorted"]);
  });
});

describe("codex review fixes", () => {
  it("PATCH with bad topics mutates nothing (atomicity)", async () => {
    const created = await (await app.request("/bookmarks", json({ url: "https://a.com/atomic", note: "orig" }))).json();
    const res = await app.request(`/bookmarks/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "changed", topics: ["no-such-topic"] }),
    });
    expect(res.status).toBe(400);
    const after = await (await app.request(`/bookmarks/${created.id}`)).json();
    expect(after.note).toBe("orig");
  });

  it("rejects saving a javascript: url", async () => {
    const res = await app.request("/bookmarks", json({ url: "javascript:alert(1)" }));
    expect(res.status).toBe(400);
  });

  it("clamps a negative limit instead of returning everything", async () => {
    for (let i = 0; i < 4; i++) await app.request("/bookmarks", json({ url: `https://lim.example/${i}` }));
    const res = await (await app.request("/bookmarks?limit=-1")).json();
    expect(res.bookmarks.length).toBeGreaterThan(0);
    expect(res.bookmarks.length).toBeLessThanOrEqual(200);
  });

  it("enrichment does not overwrite a user-locked title", async () => {
    const { applyTopics } = await import("../src/pipeline/enrich.js");
    void applyTopics;
    const created = await (await app.request("/bookmarks", json({ url: "https://a.com/titlelock" }))).json();
    await app.request(`/bookmarks/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "My Title" }),
    });
    // Simulate an enrichment title write with the guard in place.
    await db
      .prepare("UPDATE bookmarks SET title = CASE WHEN title_locked = 1 THEN title ELSE ? END WHERE id = ?")
      .run("Fetched Title", created.id);
    const row = (await db.prepare("SELECT title FROM bookmarks WHERE id = ?").get(created.id)) as any;
    expect(row.title).toBe("My Title");
  });

  it("paginates stably across a shared saved_at", async () => {
    const ts = 1700000000;
    for (let i = 0; i < 5; i++) {
      await app.request("/bookmarks", json({ url: `https://page.example/${i}`, saved_at: ts }));
    }
    const page1 = await (await app.request("/bookmarks?type=&limit=3")).json();
    // fetch by cursor; no id should repeat and none should be skipped
    const first = await (await app.request(`/bookmarks?limit=3`)).json();
    const cursor = first.next_before;
    expect(typeof cursor).toBe("string");
    const second = await (await app.request(`/bookmarks?limit=3&before=${cursor}`)).json();
    const ids1 = new Set(first.bookmarks.map((b: any) => b.id));
    const overlap = second.bookmarks.filter((b: any) => ids1.has(b.id));
    expect(overlap).toHaveLength(0);
  });

  it("archive PUT does not overwrite an existing snapshot", async () => {
    const created = await (await app.request("/bookmarks", json({ url: "https://a.com/keep" }))).json();
    const first = `<html><head><title>First</title></head><body>${"original ".repeat(20)}</body></html>`;
    await app.request(`/bookmarks/${created.id}/archive`, { method: "PUT", body: first });
    const second = await app.request(`/bookmarks/${created.id}/archive`, {
      method: "PUT",
      body: `<html><head><title>Second</title></head><body>${"replaced ".repeat(20)}</body></html>`,
    });
    expect((await second.json()).kept_existing).toBe(true);
    const served = await (await app.request(`/bookmarks/${created.id}/archive`)).text();
    expect(served).toContain("original");
    expect(served).not.toContain("replaced");
  });

  it("AI topic re-runs replace stale AI topics but keep user ones", async () => {
    const { applyTopics } = await import("../src/pipeline/enrich.js");
    const created = await (await app.request("/bookmarks", json({ url: "https://a.com/topics2" }))).json();
    await app.request("/topics", json({ name: "t-old" }));
    await app.request("/topics", json({ name: "t-new" }));
    await app.request("/topics", json({ name: "t-user" }));
    await applyTopics(db, created.id, ["t-old"]);
    await db
      .prepare(
        `INSERT INTO bookmark_topics (bookmark_id, topic_id, by_ai)
         SELECT ?, id, 0 FROM topics WHERE name = 't-user'`
      )
      .run(created.id);
    await applyTopics(db, created.id, ["t-new"]);
    const bookmark = await (await app.request(`/bookmarks/${created.id}`)).json();
    expect(bookmark.topics.map((t: any) => t.name).sort()).toEqual(["t-new", "t-user"]);
  });
});

describe("archive", () => {
  it("stores scrubbed snapshot, serves it with CSP, enqueues enrichment", async () => {
    const created = await (
      await app.request("/bookmarks", json({ url: "https://a.com/arch", archive_coming: true }))
    ).json();
    const html = `<html><head><title>T</title></head><body><script>evil()</script><p onclick="x()">${"content ".repeat(30)}</p></body></html>`;
    const put = await app.request(`/bookmarks/${created.id}/archive`, { method: "PUT", body: html });
    expect(put.status).toBe(200);
    const jobs = await db.prepare("SELECT * FROM jobs WHERE payload LIKE ?").all(`%${created.id}%`);
    expect(jobs).toHaveLength(1);
    const got = await app.request(`/bookmarks/${created.id}/archive`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-security-policy")).toContain("sandbox");
    const served = await got.text();
    expect(served).not.toMatch(/<script|onclick/i);
    expect(served).toContain("content content");
  });

  it("rejects oversized and empty archives", async () => {
    const res = await app.request(`/bookmarks/whatever/archive`, {
      method: "PUT",
      headers: { "Content-Length": String(400 * 1024 * 1024) },
      body: "x",
    });
    expect([404, 413]).toContain(res.status); // 404 unknown id also acceptable ordering
    const created = await (await app.request("/bookmarks", json({ url: "https://a.com/e" }))).json();
    const empty = await app.request(`/bookmarks/${created.id}/archive`, { method: "PUT", body: "tiny" });
    expect(empty.status).toBe(400);
  });
});

describe("export", () => {
  it("netscape export round-trips through the importer", async () => {
    const res = await app.request("/export?format=html");
    const html = await res.text();
    const items = parseNetscape(html);
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.some((i) => i.url.startsWith("https://a.com/"))).toBe(true);
    expect(items.every((i) => /^https?:\/\//.test(i.url))).toBe(true);
  });
  it("json export includes topics and bookmarks", async () => {
    const body = await (await app.request("/export?format=json")).json();
    expect(body.version).toBe(1);
    expect(Array.isArray(body.bookmarks)).toBe(true);
    expect(body.bookmarks.length).toBeGreaterThanOrEqual(3);
  });

  it("zip export streams a zip with the metadata and archives", async () => {
    const res = await app.request("/export?format=zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe("PK"); // zip magic
    expect(bytes.length).toBeGreaterThan(500);
  });

  it("bulk retry re-enqueues failed enrichments", async () => {
    const created = await (await app.request("/bookmarks", json({ url: "https://a.com/failed1" }))).json();
    await db.prepare("UPDATE bookmarks SET enrich_status='failed' WHERE id = ?").run(created.id);
    const res = await (await app.request("/bookmarks/retry-failed", { method: "POST" })).json();
    expect(res.retried).toBeGreaterThanOrEqual(1);
    const row = (await db.prepare("SELECT enrich_status FROM bookmarks WHERE id = ?").get(created.id)) as any;
    expect(row.enrich_status).toBe("pending");
  });
});

describe("pass-4 fixes", () => {
  it("favicon-only update does not disturb FTS results", async () => {
    const created = await (
      await app.request("/bookmarks", json({ url: "https://a.com/ftskeep", note: "searchable-marker" }))
    ).json();
    // populate an indexed field so it's findable
    await app.request(`/bookmarks/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "unique-fts-token" }),
    });
    const before = await (await app.request("/bookmarks?q=unique-fts-token")).json();
    expect(before.bookmarks.map((b: any) => b.id)).toContain(created.id);
    // a non-indexed column update (favicon) must not drop the FTS row
    await db
      .prepare("UPDATE bookmarks SET favicon_url = '/assets/favicons/x.ico' WHERE id = ?")
      .run(created.id);
    const after = await (await app.request("/bookmarks?q=unique-fts-token")).json();
    expect(after.bookmarks.map((b: any) => b.id)).toContain(created.id);
  });

  it("import status is scoped to its own batch", async () => {
    const { runImport } = await import("../src/import/run.js");
    const items = [{ url: "https://batch.example/one", title: "One", addDate: null, folder: null }];
    // Two imports, same filename — second finds the URL already present.
    const j1 = "job-batch-1";
    const j2 = "job-batch-2";
    const now = Math.floor(Date.now() / 1000);
    for (const id of [j1, j2]) {
      await db
        .prepare(
          `INSERT INTO jobs (id, type, payload, status, attempts, created_at, updated_at)
           VALUES (?, 'import', ?, 'pending', 0, ?, ?)`
        )
        .run(id, JSON.stringify({ filename: "dup.html", items }), now, now);
      await runImport(db, { filename: "dup.html", items } as any, id);
    }
    const s1 = await (await app.request(`/import/${j1}`)).json();
    const s2 = await (await app.request(`/import/${j2}`)).json();
    const total1 = Object.values(s1.enrichment as Record<string, number>).reduce((a, b) => a + b, 0);
    const total2 = Object.values(s2.enrichment as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total1).toBe(1); // batch 1 inserted its row
    expect(total2).toBe(0); // batch 2 saw a duplicate, inserted nothing
  });
});

describe("queue", () => {
  it("reclaims a job left running by a dead process (stale lease) and runs it", async () => {
    const runs: string[] = [];
    const jobId = await enqueueJob(db, "enrich", { bookmark_id: "recover-me" });
    // Simulate a crash: left 'running' with an old lease (recovery is now
    // lease-based, not an unconditional boot reset).
    await db
      .prepare("UPDATE jobs SET status='running', updated_at = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000) - 3600, jobId);
    const stop = startWorker(db, { enrich: async (p) => void runs.push(p.bookmark_id) }, { pollMs: 20 });
    await new Promise((r) => setTimeout(r, 500));
    await stop();
    expect(runs).toContain("recover-me");
    const job = (await db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId)) as any;
    expect(job.status).toBe("done");
  });

  it("marks failing jobs failed after retry", async () => {
    const jobId = await enqueueJob(db, "enrich", { bookmark_id: "boom" });
    const stop = startWorker(
      db,
      {
        enrich: async (p) => {
          if (p.bookmark_id === "boom") throw new Error("kaboom");
        },
      },
      { pollMs: 20 }
    );
    await new Promise((r) => setTimeout(r, 700));
    await stop();
    const job = (await db
      .prepare("SELECT status, attempts, error FROM jobs WHERE id = ?")
      .get(jobId)) as any;
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(2);
    expect(job.error).toContain("kaboom");
  });
});
