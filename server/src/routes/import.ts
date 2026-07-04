import { Hono } from "hono";
import type Database from "better-sqlite3";
import { detectFormat, parseNetscape, parseLines } from "../import/parse.js";
import { dedupeItems } from "../import/run.js";
import { enqueueJob } from "../jobs.js";

export function importRoutes(db: Database.Database): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const MAX_IMPORT = 100 * 1024 * 1024;
    if (Number(c.req.header("content-length") ?? 0) > MAX_IMPORT) {
      return c.json({ error: "import too large (100MB max)" }, 413);
    }
    let text: string;
    let filename = "import";
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) return c.json({ error: "multipart field 'file' required" }, 400);
      filename = file.name || filename;
      text = await file.text();
    } else {
      text = await c.req.text();
    }
    if (!text.trim()) return c.json({ error: "empty import" }, 400);

    const parsed = detectFormat(text) === "netscape" ? parseNetscape(text) : parseLines(text);
    const { items } = dedupeItems(parsed);
    if (!items.length) return c.json({ error: "no valid URLs found" }, 400);

    const jobId = enqueueJob(db, "import", { filename, items });
    return c.json({ job_id: jobId, count: items.length }, 202);
  });

  // Recent import jobs — lets the UI resume progress after a page reload.
  app.get("/", (c) => {
    const jobs = db
      .prepare(
        "SELECT id, status, payload, created_at FROM jobs WHERE type = 'import' ORDER BY created_at DESC LIMIT 10"
      )
      .all() as { id: string; status: string; payload: string; created_at: number }[];
    return c.json({
      imports: jobs.map((j) => {
        const payload = JSON.parse(j.payload);
        return {
          job_id: j.id,
          status: j.status,
          filename: payload.filename,
          progress: payload.progress ?? null,
          created_at: j.created_at,
        };
      }),
    });
  });

  app.get("/:job_id", (c) => {
    const job = db
      .prepare("SELECT id, status, payload, error FROM jobs WHERE id = ? AND type = 'import'")
      .get(c.req.param("job_id")) as
      | { id: string; status: string; payload: string; error: string | null }
      | undefined;
    if (!job) return c.json({ error: "not found" }, 404);
    const payload = JSON.parse(job.payload);
    const filename = payload.filename;

    // Insert progress from the job itself; enrichment progress from the rows.
    const enrichment = db
      .prepare(
        `SELECT enrich_status, COUNT(*) AS n FROM bookmarks
         WHERE saved_from = 'import' AND source_detail = ? GROUP BY enrich_status`
      )
      .all(filename) as { enrich_status: string; n: number }[];
    const enrich: Record<string, number> = {};
    for (const row of enrichment) enrich[row.enrich_status] = row.n;

    return c.json({
      job_id: job.id,
      status: job.status,
      error: job.error,
      filename,
      progress: payload.progress ?? null,
      enrichment: enrich,
    });
  });

  return app;
}
