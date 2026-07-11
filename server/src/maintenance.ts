import type { Db } from "./db.js";
import fs from "node:fs";
import path from "node:path";
import { enqueueJob } from "./jobs.js";

const TRASH_RETENTION_SECONDS = 30 * 86400;

// A bookmark whose enrichment just failed permanently is not rescued again for
// this long — without it, a page that consistently times out would be
// re-enqueued (and re-billed for LLM calls) every sweep, forever.
export const FAILED_RESCUE_BACKOFF_SECONDS = 24 * 3600;

// Deleted bookmarks sit in trash/ (row JSON + archive + thumb) for 30 days
// before their disk space is reclaimed.
export function purgeTrash(dataDir: string, now: number): number {
  const dir = path.join(dataDir, "trash");
  let purged = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs / 1000 < now - TRASH_RETENTION_SECONDS) {
        fs.rmSync(file, { force: true });
        purged++;
      }
    } catch {
      /* raced another purge */
    }
  }
  return purged;
}

// Housekeeping: purge finished jobs, and rescue bookmarks whose deferred
// enrichment never happened (archive_coming save whose snapshot never arrived).
// Returns the number of rescued bookmarks.
export async function runMaintenance(db: Db, dataDir?: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  if (dataDir) purgeTrash(dataDir, now);
  await db.prepare("DELETE FROM jobs WHERE status = 'done' AND updated_at < ?").run(now - 7 * 86400);
  await db.prepare("DELETE FROM jobs WHERE status = 'failed' AND updated_at < ?").run(now - 30 * 86400);
  const orphans = (await db
    .prepare(
      `SELECT b.id FROM bookmarks b
       WHERE b.enrich_status = 'pending' AND b.saved_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
           WHERE j.type = 'enrich' AND j.bookmark_id = b.id
             AND (j.status IN ('pending', 'running')
                  OR (j.status = 'failed' AND j.updated_at > ?))
         )`
    )
    .all(now - 120, now - FAILED_RESCUE_BACKOFF_SECONDS)) as { id: string }[];
  for (const { id } of orphans) {
    await enqueueJob(db, "enrich", { bookmark_id: id });
  }
  return orphans.length;
}
