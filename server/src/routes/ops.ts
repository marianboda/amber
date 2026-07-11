import { Hono } from "hono";
import type { Db } from "../db.js";
import fs from "node:fs";
import path from "node:path";

function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* deleted mid-walk */
      }
    }
  }
  return total;
}

async function countBy(db: Db, sql: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const row of (await db.prepare(sql).all()) as { k: string | null; n: number }[]) {
    out[row.k ?? "null"] = row.n;
  }
  return out;
}

// Operational visibility: failed jobs with their errors, queue depth, library
// stats. Fired blind otherwise — retry-failed had no way to show what failed.
export function opsRoutes(db: Db, dataDir: string): Hono {
  const app = new Hono();

  app.get("/jobs", async (c) => {
    const { status, type } = c.req.query();
    const requested = Math.trunc(Number(c.req.query("limit")));
    const limit = Math.min(requested >= 1 ? requested : 50, 200);
    const where: string[] = [];
    const params: unknown[] = [];
    if (status) {
      where.push("status = ?");
      params.push(status);
    }
    if (type) {
      where.push("type = ?");
      params.push(type);
    }
    const rows = await db
      .prepare(
        `SELECT id, type, status, attempts, error, bookmark_id, created_at, updated_at
         FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...params, limit);
    const counts = (await db
      .prepare("SELECT type, status, COUNT(*) AS n FROM jobs GROUP BY type, status")
      .all()) as { type: string; status: string; n: number }[];
    const summary: Record<string, Record<string, number>> = {};
    for (const row of counts) {
      (summary[row.type] ??= {})[row.status] = row.n;
    }
    return c.json({ jobs: rows, counts: summary });
  });

  app.get("/stats", async (c) => {
    const total = ((await db.prepare("SELECT COUNT(*) AS n FROM bookmarks").get()) as { n: number })
      .n;
    const missingGist = (
      (await db
        .prepare("SELECT COUNT(*) AS n FROM bookmarks WHERE enrich_status = 'done' AND gist IS NULL")
        .get()) as { n: number }
    ).n;
    return c.json({
      bookmarks: {
        total,
        by_enrich_status: await countBy(
          db,
          "SELECT enrich_status AS k, COUNT(*) AS n FROM bookmarks GROUP BY enrich_status"
        ),
        by_fetch_status: await countBy(
          db,
          "SELECT fetch_status AS k, COUNT(*) AS n FROM bookmarks GROUP BY fetch_status"
        ),
        by_content_type: await countBy(
          db,
          "SELECT content_type AS k, COUNT(*) AS n FROM bookmarks GROUP BY content_type"
        ),
        // Enriched without a gist = imported metadata-only; POST
        // /bookmarks/enrich-missing works this backlog in batches.
        missing_gist: missingGist,
        with_archive: (
          (await db
            .prepare("SELECT COUNT(*) AS n FROM bookmarks WHERE archive_ref IS NOT NULL")
            .get()) as { n: number }
        ).n,
      },
      jobs: await countBy(db, "SELECT status AS k, COUNT(*) AS n FROM jobs GROUP BY status"),
      disk: {
        archives_bytes: dirSize(path.join(dataDir, "archives")),
        assets_bytes: dirSize(path.join(dataDir, "assets")),
      },
    });
  });

  return app;
}
