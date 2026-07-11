import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../src/db.js";
import type { Config } from "../src/config.js";
import { isPrivateIp, assertPublicUrl } from "../src/pipeline/fetcher.js";
import { bearerAuth } from "../src/auth.js";
import { startWorker } from "../src/queue.js";
import { enqueueJob } from "../src/jobs.js";
import { TEST_DATABASE_URL } from "./pg.js";

vi.mock("../src/pipeline/fetcher.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/pipeline/fetcher.js")>();
  return {
    ...original,
    fetchPage: vi.fn(async (url: string) => {
      if (url.includes("redirects-to-owner")) {
        return {
          finalUrl: "https://owner.test/final",
          html: "<html><head><title>Final</title></head><body><p>merged content page</p></body></html>",
          contentType: "text/html",
          isHtml: true,
        };
      }
      if (url.endsWith(".pdf")) {
        return { finalUrl: url, html: "", contentType: "application/pdf", isHtml: false };
      }
      return {
        finalUrl: url,
        html: `<html><head><title>Page</title></head><body><p>content of ${url}</p></body></html>`,
        contentType: "text/html",
        isHtml: true,
      };
    }),
  };
});

let dir: string;
let db: Awaited<ReturnType<typeof openDb>>;
let config: Config;
const SCHEMA = "test_batch6";

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
});

afterAll(async () => {
  await db.pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
  await db.end();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SSRF guard: isPrivateIp", () => {
  it.each([
    ["0.0.0.0", true],
    ["10.1.2.3", true],
    ["127.0.0.1", true],
    ["100.64.0.1", true], // CGNAT low edge
    ["100.127.255.255", true], // CGNAT high edge
    ["100.63.255.255", false], // just below CGNAT
    ["100.128.0.0", false], // just above CGNAT
    ["169.254.169.254", true], // cloud metadata
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["8.8.8.8", false],
    ["::1", true],
    ["::", true],
    ["fe80::1", true], // link-local
    ["fc00::1", true], // ULA
    ["fd12:3456::1", true],
    ["::ffff:10.0.0.1", true], // IPv6-mapped private v4
    ["::ffff:8.8.8.8", false], // IPv6-mapped public v4
    ["2606:4700::1111", false],
  ])("%s → %s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe("SSRF guard: assertPublicUrl", () => {
  it("blocks non-http protocols and private hostnames/addresses", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/blocked/);
    await expect(assertPublicUrl("ftp://x.test/")).rejects.toThrow(/blocked/);
    await expect(assertPublicUrl("http://localhost/admin")).rejects.toThrow(/blocked/);
    await expect(assertPublicUrl("http://nas.local/")).rejects.toThrow(/blocked/);
    await expect(assertPublicUrl("http://db.internal/")).rejects.toThrow(/blocked/);
    await expect(assertPublicUrl("http://127.0.0.1:3000/")).rejects.toThrow(/blocked/);
    await expect(assertPublicUrl("http://[::1]/")).rejects.toThrow(/blocked/);
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /blocked/
    );
  });

  it("passes public IP literals", async () => {
    await expect(assertPublicUrl("https://8.8.8.8/x")).resolves.toBeInstanceOf(URL);
  });
});

describe("enrichment pipeline (mocked fetch)", () => {
  it("merges into the existing owner on post-redirect duplicate", async () => {
    const { enrichBookmark } = await import("../src/pipeline/enrich.js");
    const now = Math.floor(Date.now() / 1000);
    // Owner already in the library with its own note.
    await db
      .prepare(
        `INSERT INTO bookmarks (id, url, canonical_url, domain, saved_at, note, enrich_status)
         VALUES ('owner', 'https://owner.test/final', 'https://owner.test/final', 'owner.test', ?, 'owner note', 'done')`
      )
      .run(now);
    // Newcomer that will redirect onto the owner; carries note, read flag, user topic.
    await db
      .prepare(
        `INSERT INTO bookmarks (id, url, canonical_url, domain, saved_at, note, is_read, enrich_status)
         VALUES ('newcomer', 'https://redirects-to-owner.test/x', 'https://redirects-to-owner.test/x', 'redirects-to-owner.test', ?, 'newcomer note', 1, 'pending')`
      )
      .run(now);
    await db.prepare("INSERT INTO topics (id, name) VALUES ('t-dev', 'dev')").run();
    await db
      .prepare("INSERT INTO bookmark_topics (bookmark_id, topic_id, by_ai) VALUES ('newcomer', 't-dev', 0)")
      .run();

    await enrichBookmark(db, config, "newcomer");

    expect(await db.prepare("SELECT id FROM bookmarks WHERE id = 'newcomer'").get()).toBeUndefined();
    const owner = (await db.prepare("SELECT * FROM bookmarks WHERE id = 'owner'").get()) as any;
    expect(owner.note).toContain("owner note");
    expect(owner.note).toContain("newcomer note");
    expect(owner.is_read).toBe(1);
    const topics = (await db
      .prepare("SELECT topic_id, by_ai FROM bookmark_topics WHERE bookmark_id = 'owner'")
      .all()) as any[];
    expect(topics).toEqual([{ topic_id: "t-dev", by_ai: 0 }]);
  });

  it("completes a normal page and stores text + reader html", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { enrichBookmark } = await import("../src/pipeline/enrich.js");
    await db
      .prepare(
        `INSERT INTO bookmarks (id, url, canonical_url, domain, saved_at, enrich_status)
         VALUES ('plain', 'https://plain.test/a', 'https://plain.test/a', 'plain.test', ?, 'pending')`
      )
      .run(now);
    await enrichBookmark(db, config, "plain");
    const row = (await db.prepare("SELECT * FROM bookmarks WHERE id = 'plain'").get()) as any;
    expect(row.enrich_status).toBe("done");
    expect(row.fetch_status).toBe("ok");
    expect(row.content_text).toContain("content of");
  });

  it("keeps PDFs clean: no content_text, no archive, still done", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { enrichBookmark } = await import("../src/pipeline/enrich.js");
    await db
      .prepare(
        `INSERT INTO bookmarks (id, url, canonical_url, domain, saved_at, enrich_status)
         VALUES ('pdf', 'https://files.test/doc.pdf', 'https://files.test/doc.pdf', 'files.test', ?, 'pending')`
      )
      .run(now);
    await enrichBookmark(db, config, "pdf");
    const row = (await db.prepare("SELECT * FROM bookmarks WHERE id = 'pdf'").get()) as any;
    expect(row.enrich_status).toBe("done");
    expect(row.fetch_status).toBe("ok");
    expect(row.content_text).toBeNull();
    expect(row.archive_ref).toBeNull();
  });
});

describe("queue timeout & lease reclaim", () => {
  it("aborts a wedged handler via signal and fails the job after retries", async () => {
    const aborts: boolean[] = [];
    const jobId = await enqueueJob(db, "enrich", { bookmark_id: "wedge" });
    const stop = startWorker(
      db,
      {
        enrich: (_p, _id, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              aborts.push(true);
              reject(new Error("aborted"));
            });
          }),
      },
      { pollMs: 20, jobTimeoutMs: 120 }
    );
    await new Promise((r) => setTimeout(r, 900));
    await stop();
    const job = (await db.prepare("SELECT status, attempts FROM jobs WHERE id = ?").get(jobId)) as any;
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(2);
    expect(aborts.length).toBe(2);
  });

  it("does not reclaim a long-timeout job type at the default lease age", async () => {
    // A restore is allowed 30 minutes; a 700s-old lease must NOT be reclaimed
    // (and run twice concurrently), while a default-lease enrich at 700s must.
    const restoreRuns: string[] = [];
    const stop = startWorker(
      db,
      {
        enrich: async () => {},
        restore: { handler: async (p) => void restoreRuns.push(p.file), timeoutMs: 30 * 60_000 },
      },
      { pollMs: 20 }
    );
    // Insert AFTER start so boot recovery doesn't reset them.
    await new Promise((r) => setTimeout(r, 100));
    const staleAt = Math.floor(Date.now() / 1000) - 700;
    const restoreJob = await enqueueJob(db, "restore", { file: "tmp/x.zip", filename: "x.zip" });
    await db
      .prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?")
      .run(staleAt, restoreJob);
    await new Promise((r) => setTimeout(r, 300));
    await stop();
    const job = (await db.prepare("SELECT status FROM jobs WHERE id = ?").get(restoreJob)) as any;
    expect(job.status).toBe("running"); // still leased to the (simulated) first runner
    expect(restoreRuns).toHaveLength(0);
    await db.prepare("DELETE FROM jobs WHERE id = ?").run(restoreJob);
  });

  it("reclaims a stale running lease", async () => {
    const runs: string[] = [];
    const jobId = await enqueueJob(db, "enrich", { bookmark_id: "stale-lease" });
    // Simulate a wedged claim from long ago: running, updated_at far in the past.
    await db
      .prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000) - 3600, jobId);
    const stop = startWorker(db, { enrich: async (p) => void runs.push(p.bookmark_id) }, { pollMs: 20 });
    await new Promise((r) => setTimeout(r, 400));
    await stop();
    expect(runs).toContain("stale-lease");
    const job = (await db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId)) as any;
    expect(job.status).toBe("done");
  });
});

describe("auth middleware", () => {
  function authApp(token = "secret") {
    const app = new Hono();
    app.use("*", bearerAuth(token));
    app.get("/ok", (c) => c.json({ ok: true }));
    return app;
  }

  it("accepts the right token, rejects wrong/missing ones", async () => {
    const app = authApp();
    expect((await app.request("/ok", { headers: { Authorization: "Bearer secret" } })).status).toBe(200);
    expect((await app.request("/ok", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await app.request("/ok")).status).toBe(401);
    expect((await app.request("/ok", { headers: { Authorization: "Basic abc" } })).status).toBe(401);
  });

  it("rate-limits repeated failures per IP window", async () => {
    const app = authApp();
    // Same (unknown) IP for every request in tests. Burn the window:
    let last = 0;
    for (let i = 0; i < 25; i++) {
      last = (await app.request("/ok", { headers: { Authorization: `Bearer bad-${randomUUID()}` } })).status;
    }
    expect(last).toBe(429);
    // Even the RIGHT token is throttled from that IP now.
    expect((await app.request("/ok", { headers: { Authorization: "Bearer secret" } })).status).toBe(429);
  });
});
