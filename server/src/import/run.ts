import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { canonicalize, domainOf } from "../canonical.js";
import { enqueueJob } from "../jobs.js";
import type { ImportItem } from "./parse.js";

export interface ImportPayload {
  filename: string;
  items: ImportItem[];
  progress?: { total: number; imported: number; duplicates: number; invalid: number };
}

// Cross-source dedup at parse time: same canonical URL keeps the earliest
// ADD_DATE (design §8, first-seen wins).
export function dedupeItems(items: ImportItem[]): { items: ImportItem[]; dropped: number } {
  const byCanonical = new Map<string, ImportItem>();
  let invalid = 0;
  for (const item of items) {
    let key: string;
    try {
      key = canonicalize(item.url);
    } catch {
      invalid++;
      continue;
    }
    const seen = byCanonical.get(key);
    if (!seen) {
      byCanonical.set(key, item);
    } else if (item.addDate !== null && (seen.addDate === null || item.addDate < seen.addDate)) {
      byCanonical.set(key, { ...item, title: item.title ?? seen.title });
    }
  }
  return { items: [...byCanonical.values()], dropped: items.length - byCanonical.size - invalid };
}

// Job handler: inserts every item through the same path as POST /bookmarks
// (dedup against existing library, enrich job per new bookmark). Idempotent —
// a re-run after a crash skips already-inserted rows as duplicates.
export async function runImport(
  db: Database.Database,
  payload: ImportPayload,
  jobId: string
): Promise<void> {
  const progress = { total: payload.items.length, imported: 0, duplicates: 0, invalid: 0 };
  const updatePayload = db.prepare("UPDATE jobs SET payload = ? WHERE id = ?");
  const findExisting = db.prepare("SELECT id FROM bookmarks WHERE canonical_url = ?");
  const insert = db.prepare(
    `INSERT INTO bookmarks
       (id, url, canonical_url, title, domain, saved_at, saved_from, source_detail, topic_hint, import_batch)
     VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?, ?)`
  );

  const now = Math.floor(Date.now() / 1000);
  for (const [index, item] of payload.items.entries()) {
    try {
      const canonical = canonicalize(item.url);
      if (findExisting.get(canonical)) {
        progress.duplicates++;
      } else {
        const id = randomUUID();
        insert.run(
          id,
          item.url,
          canonical,
          item.title,
          domainOf(item.url),
          item.addDate ?? now,
          payload.filename,
          item.folder,
          jobId
        );
        enqueueJob(db, "enrich", { bookmark_id: id });
        progress.imported++;
      }
    } catch {
      progress.invalid++;
    }
    if (index % 50 === 0) {
      // Keep items in the payload: a crash mid-import must be able to re-run
      // the job from the stored row (already-inserted rows dedup away).
      updatePayload.run(JSON.stringify({ ...payload, progress }), jobId);
    }
  }
  // Finished: items no longer needed, keep the row small.
  updatePayload.run(JSON.stringify({ filename: payload.filename, items: [], progress }), jobId);
}
