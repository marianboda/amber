import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { canonicalize, domainOf } from "../canonical.js";
import { enqueueJob } from "../jobs.js";
import type { ImportItem } from "./parse.js";

export interface ImportPayload {
  filename: string;
  items: ImportItem[];
  // 'metadata' skips the LLM step per item (fetch/extract/archive still run);
  // POST /bookmarks/enrich-missing works the backlog later in batches.
  enrich?: "full" | "metadata";
  // Legacy: progress lived in the payload before the jobs.progress column.
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
const CHUNK_SIZE = 200;

export async function runImport(
  db: Database.Database,
  payload: ImportPayload,
  jobId: string,
  signal?: AbortSignal
): Promise<void> {
  const progress = { total: payload.items.length, imported: 0, duplicates: 0, invalid: 0 };
  const updateProgress = db.prepare("UPDATE jobs SET progress = ? WHERE id = ?");
  const findExisting = db.prepare("SELECT id FROM bookmarks WHERE canonical_url = ?");
  const insert = db.prepare(
    `INSERT INTO bookmarks
       (id, url, canonical_url, title, domain, saved_at, saved_from, source_detail, topic_hint, import_batch)
     VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?, ?)`
  );

  const now = Math.floor(Date.now() / 1000);
  const enrichPayload = (id: string) =>
    payload.enrich === "metadata"
      ? { bookmark_id: id, mode: "metadata" }
      : { bookmark_id: id };

  // One transaction per chunk: single WAL commit instead of two per item.
  // The payload keeps its items untouched throughout, so a crash mid-import
  // re-runs the job from the stored row (already-inserted rows dedup away).
  const insertChunk = db.transaction((chunk: ImportItem[]) => {
    for (const item of chunk) {
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
          enqueueJob(db, "enrich", enrichPayload(id));
          progress.imported++;
        }
      } catch {
        progress.invalid++;
      }
    }
  });

  for (let i = 0; i < payload.items.length; i += CHUNK_SIZE) {
    // Stop between chunks on job timeout — the re-run picks up where we left
    // off, and never races a still-running first attempt.
    if (signal?.aborted) throw new Error("import aborted");
    insertChunk(payload.items.slice(i, i + CHUNK_SIZE));
    updateProgress.run(JSON.stringify(progress), jobId);
    // Yield between chunks so HTTP requests stay responsive during big imports.
    await new Promise((resolve) => setImmediate(resolve));
  }
  // Finished: drop the item list, keep the row small.
  db.prepare("UPDATE jobs SET payload = ?, progress = ? WHERE id = ?").run(
    JSON.stringify({ filename: payload.filename, items: [], enrich: payload.enrich }),
    JSON.stringify(progress),
    jobId
  );
}
