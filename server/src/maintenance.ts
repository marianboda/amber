import type Database from "better-sqlite3";
import { enqueueJob } from "./jobs.js";

// A bookmark whose enrichment just failed permanently is not rescued again for
// this long — without it, a page that consistently times out would be
// re-enqueued (and re-billed for LLM calls) every sweep, forever.
export const FAILED_RESCUE_BACKOFF_SECONDS = 24 * 3600;

// Housekeeping: purge finished jobs, and rescue bookmarks whose deferred
// enrichment never happened (archive_coming save whose snapshot never arrived).
// Returns the number of rescued bookmarks.
export function runMaintenance(db: Database.Database): number {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM jobs WHERE status = 'done' AND updated_at < ?").run(now - 7 * 86400);
  db.prepare("DELETE FROM jobs WHERE status = 'failed' AND updated_at < ?").run(now - 30 * 86400);
  const orphans = db
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
    .all(now - 120, now - FAILED_RESCUE_BACKOFF_SECONDS) as { id: string }[];
  for (const { id } of orphans) {
    enqueueJob(db, "enrich", { bookmark_id: id });
  }
  return orphans.length;
}
