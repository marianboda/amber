import { Hono } from "hono";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { detectFormat, parseNetscape, parseLines } from "../import/parse.js";
import { dedupeItems } from "../import/run.js";
import { enqueueJob } from "../jobs.js";
import { readStreamLimited, streamToFileLimited } from "../http-util.js";

const MAX_RESTORE = 4 * 1024 * 1024 * 1024; // backup zips carry full archives

function looksLikeAmberExport(text: string): boolean {
  if (!text.trimStart().startsWith("{")) return false;
  try {
    const data = JSON.parse(text);
    return data?.version === 1 && Array.isArray(data?.bookmarks);
  } catch {
    return false;
  }
}

export function importRoutes(db: Database.Database, dataDir: string): Hono {
  const app = new Hono();

  // Stage an uploaded backup under tmp/ and hand it to the restore job.
  const stageRestore = (name: string, filename: string) => {
    const jobId = enqueueJob(db, "restore", { file: `tmp/${name}`, filename });
    return { job_id: jobId, restore: true };
  };

  app.post("/", async (c) => {
    const MAX_IMPORT = 100 * 1024 * 1024;
    const contentTypeHeader = c.req.header("content-type") ?? "";

    // Backup zips are restored, not parsed — and can be multi-GB, so they
    // stream straight to disk instead of buffering.
    if (contentTypeHeader.includes("application/zip")) {
      const name = `restore-${randomUUID()}.zip`;
      const written = await streamToFileLimited(
        c.req.raw.body,
        path.join(dataDir, "tmp", name),
        MAX_RESTORE
      );
      if (written === null) return c.json({ error: "backup too large (4GB max)" }, 413);
      if (written === 0) return c.json({ error: "empty upload" }, 400);
      return c.json(stageRestore(name, "amber-backup.zip"), 202);
    }

    if (Number(c.req.header("content-length") ?? 0) > MAX_IMPORT) {
      return c.json({ error: "import too large (100MB max)" }, 413);
    }
    // Buffer the raw body under a hard cap FIRST, so a chunked upload with no
    // Content-Length can't make parseBody() buffer gigabytes before we check.
    const buffered = await readStreamLimited(c.req.raw.body, MAX_IMPORT);
    if (buffered === null) return c.json({ error: "import too large (100MB max)" }, 413);

    let text: string;
    let filename = "import";
    let enrich = c.req.query("enrich") === "metadata" ? "metadata" : "full";
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await new Response(new Uint8Array(buffered), {
        headers: { "content-type": contentType },
      }).formData();
      const file = form.get("file");
      if (!(file instanceof File)) return c.json({ error: "multipart field 'file' required" }, 400);
      filename = file.name || filename;
      if (form.get("enrich") === "metadata") enrich = "metadata";
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.subarray(0, 2).toString("latin1") === "PK") {
        // A backup zip uploaded through the form (bigger ones: raw-body POST
        // with Content-Type: application/zip, which streams to disk).
        const name = `restore-${randomUUID()}.zip`;
        fs.mkdirSync(path.join(dataDir, "tmp"), { recursive: true });
        fs.writeFileSync(path.join(dataDir, "tmp", name), bytes);
        return c.json(stageRestore(name, filename), 202);
      }
      text = bytes.toString("utf8");
    } else {
      if (buffered.subarray(0, 2).toString("latin1") === "PK") {
        const name = `restore-${randomUUID()}.zip`;
        fs.mkdirSync(path.join(dataDir, "tmp"), { recursive: true });
        fs.writeFileSync(path.join(dataDir, "tmp", name), buffered);
        return c.json(stageRestore(name, "amber-backup.zip"), 202);
      }
      text = buffered.toString("utf8");
    }
    if (!text.trim()) return c.json({ error: "empty import" }, 400);

    // An Amber JSON export restores full fidelity (notes, topics, read flags,
    // enrichment) instead of being re-imported as bare URLs.
    if (looksLikeAmberExport(text)) {
      const name = `restore-${randomUUID()}.json`;
      fs.mkdirSync(path.join(dataDir, "tmp"), { recursive: true });
      fs.writeFileSync(path.join(dataDir, "tmp", name), text);
      return c.json(stageRestore(name, filename === "import" ? "amber-export.json" : filename), 202);
    }

    const parsed = detectFormat(text) === "netscape" ? parseNetscape(text) : parseLines(text);
    const { items } = dedupeItems(parsed);
    if (!items.length) return c.json({ error: "no valid URLs found" }, 400);

    // enrich=metadata: fetch/extract/archive per item but skip the LLM call —
    // lets a big first import run cheap, with LLM enrichment batched later via
    // POST /bookmarks/enrich-missing.
    const jobId = enqueueJob(db, "import", { filename, items, enrich });
    return c.json({ job_id: jobId, count: items.length, enrich }, 202);
  });

  // Recent import jobs — lets the UI resume progress after a page reload.
  // Progress lives in its own column; payload.progress is the pre-005 fallback.
  app.get("/", (c) => {
    const jobs = db
      .prepare(
        "SELECT id, status, payload, progress, created_at FROM jobs WHERE type IN ('import','restore') ORDER BY created_at DESC LIMIT 10"
      )
      .all() as {
      id: string;
      status: string;
      payload: string;
      progress: string | null;
      created_at: number;
    }[];
    return c.json({
      imports: jobs.map((j) => {
        const payload = JSON.parse(j.payload);
        return {
          job_id: j.id,
          status: j.status,
          filename: payload.filename,
          progress: j.progress ? JSON.parse(j.progress) : payload.progress ?? null,
          created_at: j.created_at,
        };
      }),
    });
  });

  app.get("/:job_id", (c) => {
    const job = db
      .prepare(
        "SELECT id, status, payload, progress, error FROM jobs WHERE id = ? AND type IN ('import','restore')"
      )
      .get(c.req.param("job_id")) as
      | {
          id: string;
          status: string;
          payload: string;
          progress: string | null;
          error: string | null;
        }
      | undefined;
    if (!job) return c.json({ error: "not found" }, 404);
    const payload = JSON.parse(job.payload);
    const filename = payload.filename;

    // Insert progress from the job itself; enrichment progress from the rows.
    // Scope by import_batch (the job id) so two same-filename imports don't
    // report each other's counts.
    const enrichment = db
      .prepare(
        `SELECT enrich_status, COUNT(*) AS n FROM bookmarks
         WHERE import_batch = ? GROUP BY enrich_status`
      )
      .all(job.id) as { enrich_status: string; n: number }[];
    const enrich: Record<string, number> = {};
    for (const row of enrichment) enrich[row.enrich_status] = row.n;

    return c.json({
      job_id: job.id,
      status: job.status,
      error: job.error,
      filename,
      progress: job.progress ? JSON.parse(job.progress) : payload.progress ?? null,
      enrichment: enrich,
    });
  });

  return app;
}
