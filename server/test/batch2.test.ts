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
import { runRestore } from "../src/import/restore.js";
import { runBackup } from "../src/backup.js";
import { purgeTrash } from "../src/maintenance.js";
import { enqueueJob } from "../src/jobs.js";
import { streamToFileLimited } from "../src/http-util.js";

let dir: string;
let db: ReturnType<typeof openDb>;
let app: Hono;
let config: Config;

function makeApp(database: ReturnType<typeof openDb>, dataDir: string, cfg: Config): Hono {
  const a = new Hono();
  a.route("/bookmarks", bookmarkRoutes(database, cfg));
  a.route("/topics", topicRoutes(database));
  a.route("/export", exportRoutes(database, dataDir));
  a.route("/import", importRoutes(database, dataDir));
  return a;
}

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
  app = makeApp(db, dir, config);
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
    db.prepare(
      "UPDATE bookmarks SET gist = 'a gist', summary = 'a summary', enrich_status = 'done', archive_ref = ? WHERE id = ?"
    ).run(`archives/${created.id}.html`, created.id);
    fs.mkdirSync(path.join(dir, "archives"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "archives", `${created.id}.html`),
      "<html><body>archived page</body></html>"
    );

    const zipRes = await app.request("/export?format=zip");
    expect(zipRes.status).toBe(200);
    const zipBytes = Buffer.from(await zipRes.arrayBuffer());
    expect(zipBytes.subarray(0, 2).toString()).toBe("PK");

    // Fresh server: new data dir, new DB.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "amber-restore-"));
    const db2 = openDb(path.join(dir2, "test.sqlite"));
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
      const job = db2.prepare("SELECT payload FROM jobs WHERE id = ?").get(job_id) as any;
      const payload = JSON.parse(job.payload);
      await runRestore(db2, dir2, payload, job_id);

      const row = db2.prepare("SELECT * FROM bookmarks WHERE id = ?").get(created.id) as any;
      expect(row).toBeDefined();
      expect(row.note).toBe("keep me");
      expect(row.title).toBe("Kept Title");
      expect(row.title_locked).toBe(1);
      expect(row.is_read).toBe(1);
      expect(row.gist).toBe("a gist");
      expect(row.enrich_status).toBe("done");
      const topics = db2
        .prepare(
          `SELECT t.name, t.color, bt.by_ai FROM bookmark_topics bt
           JOIN topics t ON t.id = bt.topic_id WHERE bt.bookmark_id = ?`
        )
        .all(created.id) as any[];
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
      const againJob = db2.prepare("SELECT payload FROM jobs WHERE id = ?").get(againBody.job_id) as any;
      await runRestore(db2, dir2, JSON.parse(againJob.payload), againBody.job_id);
      const progress = JSON.parse(
        (db2.prepare("SELECT progress FROM jobs WHERE id = ?").get(againBody.job_id) as any).progress
      );
      expect(progress.bookmarks_restored).toBe(0);
      expect(progress.bookmarks_skipped).toBeGreaterThanOrEqual(1);
      const count = (db2.prepare("SELECT COUNT(*) AS n FROM bookmarks").get() as any).n;
      expect(count).toBe(1);
    } finally {
      db2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("detects a plain JSON export upload and restores it", async () => {
    const exportRes = await app.request("/export?format=json");
    const exportText = await exportRes.text();

    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "amber-restore-json-"));
    const db3 = openDb(path.join(dir3, "test.sqlite"));
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
      const job = db3.prepare("SELECT payload FROM jobs WHERE id = ?").get(job_id) as any;
      await runRestore(db3, dir3, JSON.parse(job.payload), job_id);
      const count = (db3.prepare("SELECT COUNT(*) AS n FROM bookmarks").get() as any).n;
      expect(count).toBeGreaterThanOrEqual(1);
    } finally {
      db3.close();
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
    const db4 = openDb(path.join(dir4, "test.sqlite"));
    try {
      fs.mkdirSync(path.join(dir4, "tmp"), { recursive: true });
      fs.writeFileSync(path.join(dir4, "tmp", "evil.zip"), evilZip);
      const jobId = enqueueJob(db4, "restore", { file: "tmp/evil.zip", filename: "evil.zip" });
      // yauzl refuses traversal entries outright; either way no file may land.
      await expect(
        runRestore(db4, dir4, { file: "tmp/evil.zip", filename: "evil.zip" }, jobId)
      ).rejects.toThrow(/invalid relative path/);
      expect(fs.existsSync(path.join(dir4, "evil.txt"))).toBe(false);
      expect(fs.existsSync(path.join(os.tmpdir(), "evil.txt"))).toBe(false);
    } finally {
      db4.close();
      fs.rmSync(dir4, { recursive: true, force: true });
    }
  });
});

describe("trash", () => {
  it("moves deleted bookmarks and their files to trash, purged after 30 days", async () => {
    const created = await (
      await app.request("/bookmarks", json({ url: "https://trash.test/x", note: "bye" }))
    ).json();
    db.prepare("UPDATE bookmarks SET archive_ref = ? WHERE id = ?").run(
      `archives/${created.id}.html`,
      created.id
    );
    fs.mkdirSync(path.join(dir, "archives"), { recursive: true });
    fs.writeFileSync(path.join(dir, "archives", `${created.id}.html`), "<html>trash me</html>");

    const res = await app.request(`/bookmarks/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT id FROM bookmarks WHERE id = ?").get(created.id)).toBeUndefined();
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
  it("writes a consistent daily snapshot and rotates old ones", async () => {
    const file = await runBackup(db, dir, 2);
    expect(file).toBeTruthy();
    const check = openDb(file!); // opens + migrates cleanly = valid DB
    const n = (check.prepare("SELECT COUNT(*) AS n FROM bookmarks").get() as any).n;
    check.close();
    expect(n).toBeGreaterThanOrEqual(1);
    // Same day: no second snapshot.
    expect(await runBackup(db, dir, 2)).toBeNull();
    // Rotation: seed fake old snapshots, keep=2 leaves the two newest.
    const backups = path.join(dir, "backups");
    fs.writeFileSync(path.join(backups, "amber-2000-01-01.sqlite"), "x");
    fs.writeFileSync(path.join(backups, "amber-2000-01-02.sqlite"), "x");
    fs.rmSync(file!, { force: true });
    const again = await runBackup(db, dir, 2);
    expect(again).toBeTruthy();
    const left = fs.readdirSync(backups).filter((f) => f.endsWith(".sqlite")).sort();
    expect(left).toHaveLength(2);
    expect(left).toContain(path.basename(again!));
    expect(left).not.toContain("amber-2000-01-01.sqlite");
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
