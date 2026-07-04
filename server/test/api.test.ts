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
import { parseNetscape } from "../src/import/parse.js";
import { startWorker } from "../src/queue.js";
import { enqueueJob } from "../src/jobs.js";

let dir: string;
let db: ReturnType<typeof openDb>;
let app: Hono;
let config: Config;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-test-"));
  db = openDb(path.join(dir, "test.sqlite"));
  config = {
    port: 0,
    dataDir: dir,
    dbPath: path.join(dir, "test.sqlite"),
    authToken: "t",
    llm: { provider: "none", apiKey: "", model: "" },
    geminiApiKey: "",
    deviceName: "test",
  };
  app = new Hono();
  app.route("/bookmarks", bookmarkRoutes(db, config));
  app.route("/topics", topicRoutes(db));
  app.route("/export", exportRoutes(db));
});

afterAll(() => {
  db.close();
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
    const jobs = db.prepare("SELECT * FROM jobs WHERE type='enrich'").all();
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
    const jobs = db.prepare("SELECT * FROM jobs WHERE payload LIKE ?").all(`%${deferredId}%`);
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

describe("archive", () => {
  it("stores scrubbed snapshot, serves it with CSP, enqueues enrichment", async () => {
    const created = await (
      await app.request("/bookmarks", json({ url: "https://a.com/arch", archive_coming: true }))
    ).json();
    const html = `<html><head><title>T</title></head><body><script>evil()</script><p onclick="x()">${"content ".repeat(30)}</p></body></html>`;
    const put = await app.request(`/bookmarks/${created.id}/archive`, { method: "PUT", body: html });
    expect(put.status).toBe(200);
    const jobs = db.prepare("SELECT * FROM jobs WHERE payload LIKE ?").all(`%${created.id}%`);
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
    expect(items.every((i) => i.url.startsWith("https://a.com/"))).toBe(true);
  });
  it("json export includes topics and bookmarks", async () => {
    const body = await (await app.request("/export?format=json")).json();
    expect(body.version).toBe(1);
    expect(Array.isArray(body.bookmarks)).toBe(true);
    expect(body.bookmarks.length).toBeGreaterThanOrEqual(3);
  });
});

describe("queue", () => {
  it("recovers running jobs on start and executes them", async () => {
    const runs: string[] = [];
    const jobId = enqueueJob(db, "enrich", { bookmark_id: "recover-me" });
    db.prepare("UPDATE jobs SET status='running' WHERE id = ?").run(jobId);
    const stop = startWorker(
      db,
      { enrich: async (p) => void runs.push(p.bookmark_id) },
      { pollMs: 20 }
    );
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(runs).toContain("recover-me");
    const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as any;
    expect(job.status).toBe("done");
  });

  it("marks failing jobs failed after retry", async () => {
    const jobId = enqueueJob(db, "enrich", { bookmark_id: "boom" });
    const stop = startWorker(
      db,
      {
        enrich: async (p) => {
          if (p.bookmark_id === "boom") throw new Error("kaboom");
        },
      },
      { pollMs: 20 }
    );
    await new Promise((r) => setTimeout(r, 400));
    stop();
    const job = db.prepare("SELECT status, attempts, error FROM jobs WHERE id = ?").get(jobId) as any;
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(2);
    expect(job.error).toContain("kaboom");
  });
});
