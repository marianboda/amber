import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../src/db.js";
import { TEST_DATABASE_URL } from "./pg.js";
import type { Config } from "../src/config.js";
import { bookmarkRoutes } from "../src/routes/bookmarks.js";
import { opsRoutes } from "../src/routes/ops.js";
import { importRoutes } from "../src/routes/import.js";
import { runImport } from "../src/import/run.js";
import { runMaintenance, FAILED_RESCUE_BACKOFF_SECONDS } from "../src/maintenance.js";
import { enqueueJob } from "../src/jobs.js";
import { startWorker } from "../src/queue.js";

let dir: string;
let db: Awaited<ReturnType<typeof openDb>>;
let app: Hono;
const SCHEMA = "test_batch1";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-test-"));
  db = await openDb(TEST_DATABASE_URL, { schema: SCHEMA });
  const config: Config = {
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
  app.route("/import", importRoutes(db, dir));
  app.route("/", opsRoutes(db, dir));
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

async function insertBookmark(fields: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const row = {
    id,
    url: `https://m.test/${id}`,
    canonical_url: `https://m.test/${id}`,
    saved_at: Math.floor(Date.now() / 1000) - 3600,
    enrich_status: "pending",
    ...fields,
  };
  const cols = Object.keys(row);
  await db
    .prepare(`INSERT INTO bookmarks (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...Object.values(row));
  return id;
}

describe("maintenance rescue", () => {
  it("rescues an orphaned pending bookmark exactly once", async () => {
    const id = await insertBookmark();
    expect(await runMaintenance(db)).toBe(1);
    const jobs = (await db
      .prepare("SELECT * FROM jobs WHERE bookmark_id = ? AND type = 'enrich'")
      .all(id)) as any[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("pending");
    // Second sweep sees the pending job and does not re-enqueue.
    expect(await runMaintenance(db)).toBe(0);
    await db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
    await db.prepare("DELETE FROM jobs WHERE bookmark_id = ?").run(id);
  });

  it("does not rescue a bookmark whose enrichment recently failed (no infinite loop)", async () => {
    const id = await insertBookmark();
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare(
        `INSERT INTO jobs (id, type, payload, status, attempts, created_at, updated_at, bookmark_id)
         VALUES (?, 'enrich', ?, 'failed', 2, ?, ?, ?)`
      )
      .run(randomUUID(), JSON.stringify({ bookmark_id: id }), now, now, id);
    expect(await runMaintenance(db)).toBe(0);
    // Once the failure ages past the backoff, one retry is allowed again.
    await db
      .prepare("UPDATE jobs SET updated_at = ? WHERE bookmark_id = ?")
      .run(now - FAILED_RESCUE_BACKOFF_SECONDS - 60, id);
    expect(await runMaintenance(db)).toBe(1);
    await db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
    await db.prepare("DELETE FROM jobs WHERE bookmark_id = ?").run(id);
  });
});

describe("permanent failure stamps the bookmark", () => {
  it("marks the bookmark failed when its enrich job exhausts retries", async () => {
    const id = await insertBookmark();
    await enqueueJob(db, "enrich", { bookmark_id: id });
    const stop = startWorker(
      db,
      {
        enrich: async () => {
          throw new Error("always broken");
        },
      },
      {
        pollMs: 20,
        onPermanentFailure: async (job) => {
          if (job.type === "enrich" && job.bookmark_id) {
            await db
              .prepare(
                "UPDATE bookmarks SET enrich_status = 'failed' WHERE id = ? AND enrich_status = 'pending'"
              )
              .run(job.bookmark_id);
          }
        },
      }
    );
    await new Promise((r) => setTimeout(r, 800));
    await stop();
    const row = (await db.prepare("SELECT enrich_status FROM bookmarks WHERE id = ?").get(id)) as any;
    expect(row.enrich_status).toBe("failed");
    // And the maintenance sweep leaves it alone — the loop is closed.
    expect(await runMaintenance(db)).toBe(0);
    await db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
    await db.prepare("DELETE FROM jobs WHERE bookmark_id = ?").run(id);
  });
});

describe("jobs.bookmark_id", () => {
  it("is populated by enqueueJob for enrich payloads", async () => {
    const jobId = await enqueueJob(db, "enrich", { bookmark_id: "bm-123" });
    const job = (await db.prepare("SELECT bookmark_id FROM jobs WHERE id = ?").get(jobId)) as any;
    expect(job.bookmark_id).toBe("bm-123");
    await db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
  });
});

describe("list payload", () => {
  it("excludes content_text from the list but keeps it on detail", async () => {
    const created = await (
      await app.request("/bookmarks", json({ url: "https://a.test/big", note: "cardnote" }))
    ).json();
    await db
      .prepare("UPDATE bookmarks SET content_text = ? WHERE id = ?")
      .run("x".repeat(5000), created.id);
    const list = await (await app.request("/bookmarks")).json();
    const card = list.bookmarks.find((b: any) => b.id === created.id);
    expect(card).toBeDefined();
    expect("content_text" in card).toBe(false);
    expect(card.note).toBe("cardnote");
    expect(Array.isArray(card.topics)).toBe(true);
    const detail = await (await app.request(`/bookmarks/${created.id}`)).json();
    expect(detail.content_text).toHaveLength(5000);
  });
});

describe("enrich-missing", () => {
  it("re-enqueues only done rows without a gist, respecting the limit", async () => {
    const missing1 = await insertBookmark({ enrich_status: "done", gist: null });
    const missing2 = await insertBookmark({ enrich_status: "done", gist: null });
    const enriched = await insertBookmark({ enrich_status: "done", gist: "already has one" });
    const res = await (await app.request("/bookmarks/enrich-missing", json({ limit: 1 }))).json();
    expect(res.enqueued).toBe(1);
    expect(res.remaining).toBeGreaterThanOrEqual(1);
    const res2 = await (await app.request("/bookmarks/enrich-missing", json({}))).json();
    expect(res2.enqueued).toBeGreaterThanOrEqual(1);
    for (const id of [missing1, missing2]) {
      const row = (await db.prepare("SELECT enrich_status FROM bookmarks WHERE id = ?").get(id)) as any;
      expect(row.enrich_status).toBe("pending");
      const jobs = await db.prepare("SELECT id FROM jobs WHERE bookmark_id = ?").all(id);
      expect(jobs).toHaveLength(1);
    }
    const untouched = (await db
      .prepare("SELECT enrich_status FROM bookmarks WHERE id = ?")
      .get(enriched)) as any;
    expect(untouched.enrich_status).toBe("done");
  });
});

describe("import", () => {
  it("metadata mode tags enrich jobs and fills the progress column", async () => {
    const items = [
      { url: "https://imp.test/one", title: "One", addDate: null, folder: null },
      { url: "https://imp.test/two", title: "Two", addDate: null, folder: null },
    ];
    const jobId = await enqueueJob(db, "import", { filename: "meta.html", items, enrich: "metadata" });
    await runImport(db, { filename: "meta.html", items, enrich: "metadata" }, jobId);
    const job = (await db.prepare("SELECT payload, progress FROM jobs WHERE id = ?").get(jobId)) as any;
    const progress = JSON.parse(job.progress);
    expect(progress).toEqual({ total: 2, imported: 2, duplicates: 0, invalid: 0 });
    expect(JSON.parse(job.payload).items).toEqual([]);
    const enrichJobs = (await db
      .prepare(
        "SELECT payload FROM jobs WHERE type = 'enrich' AND bookmark_id IN (SELECT id FROM bookmarks WHERE import_batch = ?)"
      )
      .all(jobId)) as any[];
    expect(enrichJobs).toHaveLength(2);
    for (const j of enrichJobs) expect(JSON.parse(j.payload).mode).toBe("metadata");
    const status = await (await app.request(`/import/${jobId}`)).json();
    expect(status.progress).toEqual(progress);
  });

  it("accepts enrich=metadata via query param", async () => {
    const res = await app.request("/import?enrich=metadata", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "https://imp.test/three\n",
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.enrich).toBe("metadata");
    const job = (await db.prepare("SELECT payload FROM jobs WHERE id = ?").get(body.job_id)) as any;
    expect(JSON.parse(job.payload).enrich).toBe("metadata");
  });
});

describe("ops routes", () => {
  it("lists jobs with filters and counts", async () => {
    const res = await (await app.request("/jobs?type=enrich&limit=5")).json();
    expect(Array.isArray(res.jobs)).toBe(true);
    expect(res.jobs.length).toBeLessThanOrEqual(5);
    for (const j of res.jobs) expect(j.type).toBe("enrich");
    expect(res.counts.enrich).toBeDefined();
  });

  it("reports stats", async () => {
    const res = await (await app.request("/stats")).json();
    expect(res.bookmarks.total).toBeGreaterThan(0);
    expect(res.bookmarks.by_enrich_status).toBeDefined();
    expect(typeof res.bookmarks.missing_gist).toBe("number");
    expect(res.jobs).toBeDefined();
    expect(typeof res.disk.archives_bytes).toBe("number");
  });
});
