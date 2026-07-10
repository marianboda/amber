import { Hono } from "hono";
import type Database from "better-sqlite3";
import { detectFormat, parseNetscape, parseLines } from "../import/parse.js";
import { dedupeItems } from "../import/run.js";
import { enqueueJob } from "../jobs.js";
import { readStreamLimited } from "../http-util.js";

export function importRoutes(db: Database.Database): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const MAX_IMPORT = 100 * 1024 * 1024;
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
      text = await file.text();
    } else {
      text = buffered.toString("utf8");
    }
    if (!text.trim()) return c.json({ error: "empty import" }, 400);

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
        "SELECT id, status, payload, progress, created_at FROM jobs WHERE type = 'import' ORDER BY created_at DESC LIMIT 10"
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
        "SELECT id, status, payload, progress, error FROM jobs WHERE id = ? AND type = 'import'"
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
