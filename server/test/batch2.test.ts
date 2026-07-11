import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDb } from "../src/db.js";
import type { Config } from "../src/config.js";
import { bookmarkRoutes } from "../src/routes/bookmarks.js";
import { topicRoutes } from "../src/routes/topics.js";
import { exportRoutes } from "../src/routes/export.js";
import { importRoutes } from "../src/routes/import.js";
import { runRestore } from "../src/import/restore.js";
import { runBackup } from "../src/backup.js";
import { purgeTrash } from "../src/maintenance.js";
import { enqueueJob } from "../src/jobs.js";
import { streamToFileLimited } from "../src/http-util.js";
import { TEST_DATABASE_URL } from "./pg.js";

const execFileAsync = promisify(execFile);

type Db = Awaited<ReturnType<typeof openDb>>;
let dir: string;
let db: Db;
let app: Hono;
let config: Config;
const SCHEMA = "test_batch2";

function makeApp(database: Db, dataDir: string, cfg: Config): Hono {
  const a = new Hono();
  a.route("/bookmarks", bookmarkRoutes(database, cfg));
  a.route("/topics", topicRoutes(database));
  a.route("/export", exportRoutes(database, dataDir));
  a.route("/import", importRoutes(database, dataDir));
  return a;
}

// A throwaway isolated database (its own schema) for "fresh server" scenarios,
// with a cleanup that drops the schema and closes the pool.
async function openFresh(schema: string): Promise<{ db: Db; cleanup: () => Promise<void> }> {
  const fresh = await openDb(TEST_DATABASE_URL, { schema });
  return {
    db: fresh,
    cleanup: async () => {
      await fresh.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await fresh.end();
    },
  };
}

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
  app = makeApp(db, dir, config);
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

describe("restore round trip", () => {
  it("restores a zip backup into a fresh server, archives included", async () => {
    // Build a small library: bookmark + topic + note + archive file.
    const created = await (
      await app.request("/bookmarks", json({ url: "https://rt.test/article", note: "keep me" }))
    ).json();
    await app.request("/topics", json({ name: "restoreme", color: "#123456" }));
    await app.request(`/bookmarks/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topics: ["restoreme"], is_read: true, title: "Kept Title" }),
    });
    await db
      .prepare(
        "UPDATE bookmarks SET gist = 'a gist', summary = 'a summary', enrich_status = 'done', archive_ref = ? WHERE id = ?"
      )
      .run(`archives/${created.id}.html`, created.id);
    fs.mkdirSync(path.join(dir, "archives"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "archives", `${created.id}.html`),
      "<html><body>archived page</body></html>"
    );

    const zipRes = await app.request("/export?format=zip");
    expect(zipRes.status).toBe(200);
    const zipBytes = Buffer.from(await zipRes.arrayBuffer());
    expect(zipBytes.subarray(0, 2).toString()).toBe("PK");

    // Fresh server: new data dir, new (isolated) DB.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "amber-restore-"));
    const { db: db2, cleanup } = await openFresh("test_batch2_b");
    try {
      const app2 = makeApp(db2, dir2, { ...config, dataDir: dir2 });
      const upload = await app2.request("/import", {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: zipBytes,
      });
      expect(upload.status).toBe(202);
      const { job_id, restore } = await upload.json();
      expect(restore).toBe(true);
      const job = (await db2.prepare("SELECT payload FROM jobs WHERE id = ?").get(job_id)) as any;
      const payload = JSON.parse(job.payload);
      await runRestore(db2, dir2, payload, job_id);

      const row = (await db2.prepare("SELECT * FROM bookmarks WHERE id = ?").get(created.id)) as any;
      expect(row).toBeDefined();
      expect(row.note).toBe("keep me");
      expect(row.title).toBe("Kept Title");
      expect(row.title_locked).toBe(1);
      expect(row.is_read).toBe(1);
      expect(row.gist).toBe("a gist");
      expect(row.enrich_status).toBe("done");
      const topics = (await db2
        .prepare(
          `SELECT t.name, t.color, bt.by_ai FROM bookmark_topics bt
           JOIN topics t ON t.id = bt.topic_id WHERE bt.bookmark_id = ?`
        )
        .all(created.id)) as any[];
      expect(topics).toEqual([{ name: "restoreme", color: "#123456", by_ai: 0 }]);
      expect(
        fs.readFileSync(path.join(dir2, "archives", `${created.id}.html`), "utf8")
      ).toContain("archived page");
      // Staged upload cleaned up.
      expect(fs.readdirSync(path.join(dir2, "tmp"))).toHaveLength(0);

      // Idempotent: re-running the restore (fresh staging of the same zip)
      // skips everything instead of duplicating.
      const again = await app2.request("/import", {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: zipBytes,
      });
      const againBody = await again.json();
      const againJob = (await db2
        .prepare("SELECT payload FROM jobs WHERE id = ?")
        .get(againBody.job_id)) as any;
      await runRestore(db2, dir2, JSON.parse(againJob.payload), againBody.job_id);
      const progress = JSON.parse(
        ((await db2.prepare("SELECT progress FROM jobs WHERE id = ?").get(againBody.job_id)) as any)
          .progress
      );
      expect(progress.bookmarks_restored).toBe(0);
      expect(progress.bookmarks_skipped).toBeGreaterThanOrEqual(1);
      const count = ((await db2.prepare("SELECT COUNT(*) AS n FROM bookmarks").get()) as any).n;
      expect(count).toBe(1);
    } finally {
      await cleanup();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("detects a plain JSON export upload and restores it", async () => {
    const exportRes = await app.request("/export?format=json");
    const exportText = await exportRes.text();

    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "amber-restore-json-"));
    const { db: db3, cleanup } = await openFresh("test_batch2_json");
    try {
      const app3 = makeApp(db3, dir3, { ...config, dataDir: dir3 });
      const upload = await app3.request("/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: exportText,
      });
      expect(upload.status).toBe(202);
      const { job_id, restore } = await upload.json();
      expect(restore).toBe(true);
      const job = (await db3.prepare("SELECT payload FROM jobs WHERE id = ?").get(job_id)) as any;
      await runRestore(db3, dir3, JSON.parse(job.payload), job_id);
      const count = ((await db3.prepare("SELECT COUNT(*) AS n FROM bookmarks").get()) as any).n;
      expect(count).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup();
      fs.rmSync(dir3, { recursive: true, force: true });
    }
  });

  it("still treats a plain URL list as a normal import", async () => {
    const res = await app.request("/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "https://plain.test/one\n",
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.restore).toBeUndefined();
    expect(body.count).toBe(1);
  });

  it("rejects a zip with unsafe entry paths without writing files", async () => {
    // Hand-build a tiny zip with a traversal name using archiver.
    const { ZipArchive } = await import("archiver");
    const zip = new ZipArchive({ zlib: { level: 0 } });
    const chunks: Buffer[] = [];
    zip.on("data", (c: Buffer) => chunks.push(c));
    zip.append(JSON.stringify({ version: 1, topics: [], bookmarks: [] }), {
      name: "amber-export.json",
    });
    zip.append("evil", { name: "archives/../../evil.txt" });
    await zip.finalize();
    const evilZip = Buffer.concat(chunks);

    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), "amber-evil-"));
    const { db: db4, cleanup } = await openFresh("test_batch2_evil");
    try {
      fs.mkdirSync(path.join(dir4, "tmp"), { recursive: true });
      fs.writeFileSync(path.join(dir4, "tmp", "evil.zip"), evilZip);
      const jobId = await enqueueJob(db4, "restore", { file: "tmp/evil.zip", filename: "evil.zip" });
      // yauzl refuses traversal entries outright; either way no file may land.
      await expect(
        runRestore(db4, dir4, { file: "tmp/evil.zip", filename: "evil.zip" }, jobId)
      ).rejects.toThrow(/invalid relative path/);
      expect(fs.existsSync(path.join(dir4, "evil.txt"))).toBe(false);
      expect(fs.existsSync(path.join(os.tmpdir(), "evil.txt"))).toBe(false);
    } finally {
      await cleanup();
      fs.rmSync(dir4, { recursive: true, force: true });
    }
  });
});

describe("pass-6 fixes", () => {
  it("sanitizes hostile refs in restored metadata", async () => {
    const dirS = fs.mkdtempSync(path.join(os.tmpdir(), "amber-sanitize-"));
    const { db: dbS, cleanup } = await openFresh("test_batch2_sanitize");
    try {
      const evil = {
        version: 1,
        topics: [],
        bookmarks: [
          {
            id: "evil-1",
            url: "https://e.test/x",
            canonical_url: "https://e.test/x",
            saved_at: 1000,
            archive_ref: "../../../etc/hosts",
            media_ref: "../secrets.bin",
            og_image_url: "/assets/../../db.sqlite",
            favicon_url: "https://ok.test/favicon.ico",
          },
          {
            id: "good-1",
            url: "https://e.test/y",
            canonical_url: "https://e.test/y",
            saved_at: 1000,
            archive_ref: "archives/good-1.html",
            og_image_url: "/assets/thumbs/good-1.png",
          },
        ],
      };
      fs.mkdirSync(path.join(dirS, "tmp"), { recursive: true });
      fs.writeFileSync(path.join(dirS, "tmp", "evil.json"), JSON.stringify(evil));
      const jobId = await enqueueJob(dbS, "restore", { file: "tmp/evil.json", filename: "e.json" });
      await runRestore(dbS, dirS, { file: "tmp/evil.json", filename: "e.json" }, jobId);
      const evilRow = (await dbS.prepare("SELECT * FROM bookmarks WHERE id = 'evil-1'").get()) as any;
      expect(evilRow.archive_ref).toBeNull();
      expect(evilRow.media_ref).toBeNull();
      expect(evilRow.og_image_url).toBeNull();
      expect(evilRow.favicon_url).toBe("https://ok.test/favicon.ico");
      const goodRow = (await dbS.prepare("SELECT * FROM bookmarks WHERE id = 'good-1'").get()) as any;
      expect(goodRow.archive_ref).toBe("archives/good-1.html");
      expect(goodRow.og_image_url).toBe("/assets/thumbs/good-1.png");
    } finally {
      await cleanup();
      fs.rmSync(dirS, { recursive: true, force: true });
    }
  });

  it("archivePath refuses refs that resolve outside archives/", async () => {
    const { archivePath } = await import("../src/routes/bookmarks.js");
    expect(archivePath("/data", "archives/x.html")).toBe("/data/archives/x.html");
    expect(archivePath("/data", "../etc/passwd")).toBeNull();
    expect(archivePath("/data", "archives/../amber.sqlite")).toBeNull();
    expect(archivePath("/data", "assets/thumbs/x.png")).toBeNull();
  });

  it("extraction leaves no temp files and recovers from a stale one", async () => {
    // Reuse the round-trip zip: stale .restoretmp from a "crashed" run must be
    // replaced by a complete file.
    const created = await (
      await app.request("/bookmarks", json({ url: "https://tmpfix.test/a" }))
    ).json();
    await db
      .prepare("UPDATE bookmarks SET archive_ref = ? WHERE id = ?")
      .run(`archives/${created.id}.html`, created.id);
    fs.mkdirSync(path.join(dir, "archives"), { recursive: true });
    fs.writeFileSync(path.join(dir, "archives", `${created.id}.html`), "<html>full copy</html>");
    const zipBytes = Buffer.from(await (await app.request("/export?format=zip")).arrayBuffer());

    const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), "amber-tmpfix-"));
    const { db: db5, cleanup } = await openFresh("test_batch2_tmpfix");
    try {
      // Simulate the crash artifact.
      fs.mkdirSync(path.join(dir5, "archives"), { recursive: true });
      fs.writeFileSync(path.join(dir5, "archives", `${created.id}.html.restoretmp`), "trunc");
      fs.mkdirSync(path.join(dir5, "tmp"), { recursive: true });
      fs.writeFileSync(path.join(dir5, "tmp", "b.zip"), zipBytes);
      const jobId = await enqueueJob(db5, "restore", { file: "tmp/b.zip", filename: "b.zip" });
      await runRestore(db5, dir5, { file: "tmp/b.zip", filename: "b.zip" }, jobId);
      expect(fs.readFileSync(path.join(dir5, "archives", `${created.id}.html`), "utf8")).toBe(
        "<html>full copy</html>"
      );
      const leftovers = fs
        .readdirSync(path.join(dir5, "archives"))
        .filter((f) => f.endsWith(".restoretmp") && f.startsWith(created.id));
      expect(leftovers).toHaveLength(0);
    } finally {
      await cleanup();
      fs.rmSync(dir5, { recursive: true, force: true });
    }
  });
});

describe("trash", () => {
  it("moves deleted bookmarks and their files to trash, purged after 30 days", async () => {
    const created = await (
      await app.request("/bookmarks", json({ url: "https://trash.test/x", note: "bye" }))
    ).json();
    await db
      .prepare("UPDATE bookmarks SET archive_ref = ? WHERE id = ?")
      .run(`archives/${created.id}.html`, created.id);
    fs.mkdirSync(path.join(dir, "archives"), { recursive: true });
    fs.writeFileSync(path.join(dir, "archives", `${created.id}.html`), "<html>trash me</html>");

    const res = await app.request(`/bookmarks/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await db.prepare("SELECT id FROM bookmarks WHERE id = ?").get(created.id)).toBeUndefined();
    const trashJson = path.join(dir, "trash", `${created.id}.json`);
    const trashHtml = path.join(dir, "trash", `${created.id}.html`);
    expect(fs.existsSync(trashJson)).toBe(true);
    expect(fs.existsSync(trashHtml)).toBe(true);
    expect(fs.existsSync(path.join(dir, "archives", `${created.id}.html`))).toBe(false);
    const dump = JSON.parse(fs.readFileSync(trashJson, "utf8"));
    expect(dump.bookmark.note).toBe("bye");

    // Fresh files survive a purge; 31-day-old ones don't.
    const now = Math.floor(Date.now() / 1000);
    expect(purgeTrash(dir, now)).toBe(0);
    const old = new Date((now - 31 * 86400) * 1000);
    fs.utimesSync(trashJson, old, old);
    fs.utimesSync(trashHtml, old, old);
    expect(purgeTrash(dir, now)).toBe(2);
    expect(fs.existsSync(trashJson)).toBe(false);
  });
});

describe("backup", () => {
  it("writes a consistent daily pg_dump snapshot and rotates old ones", async () => {
    // pg_dump must be on PATH; if not (bare CI), the feature is a no-op and
    // there's nothing to assert.
    let hasPgDump = true;
    try {
      await execFileAsync("pg_dump", ["--version"], { timeout: 5000 });
    } catch {
      hasPgDump = false;
    }
    if (!hasPgDump) {
      console.warn("backup test skipped: pg_dump not on PATH");
      expect(await runBackup(TEST_DATABASE_URL, dir, 2)).toBeNull();
      return;
    }

    const file = await runBackup(TEST_DATABASE_URL, dir, 2);
    expect(file).toBeTruthy();
    expect(file!.endsWith(".dump")).toBe(true);
    // Custom-format pg_dump files begin with the "PGDMP" magic.
    const head = fs.readFileSync(file!).subarray(0, 5).toString("latin1");
    expect(head).toBe("PGDMP");
    expect(fs.statSync(file!).size).toBeGreaterThan(0);
    // Same day: no second snapshot.
    expect(await runBackup(TEST_DATABASE_URL, dir, 2)).toBeNull();
    // Rotation: seed fake old snapshots, keep=2 leaves the two newest.
    const backups = path.join(dir, "backups");
    fs.writeFileSync(path.join(backups, "amber-2000-01-01.dump"), "x");
    fs.writeFileSync(path.join(backups, "amber-2000-01-02.dump"), "x");
    fs.rmSync(file!, { force: true });
    const again = await runBackup(TEST_DATABASE_URL, dir, 2);
    expect(again).toBeTruthy();
    const left = fs
      .readdirSync(backups)
      .filter((f) => f.endsWith(".dump"))
      .sort();
    expect(left).toHaveLength(2);
    expect(left).toContain(path.basename(again!));
    expect(left).not.toContain("amber-2000-01-01.dump");
  });
});

describe("streamToFileLimited", () => {
  it("caps oversized uploads and removes the partial file", async () => {
    const big = new Blob([Buffer.alloc(2048)]);
    const target = path.join(dir, "tmp", "capped.bin");
    const written = await streamToFileLimited(big.stream() as any, target, 1024);
    expect(written).toBeNull();
    expect(fs.existsSync(target)).toBe(false);
    const ok = await streamToFileLimited(new Blob(["hello"]).stream() as any, target, 1024);
    expect(ok).toBe(5);
    expect(fs.readFileSync(target, "utf8")).toBe("hello");
  });
});
