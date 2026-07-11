import type { Db } from "../db.js";
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
  db: Db,
  payload: ImportPayload,
  jobId: string,
  signal?: AbortSignal
): Promise<void> {
  const progress = { total: payload.items.length, imported: 0, duplicates: 0, invalid: 0 };

  const now = Math.floor(Date.now() / 1000);
  const enrichPayload = (id: string) =>
    payload.enrich === "metadata" ? { bookmark_id: id, mode: "metadata" } : { bookmark_id: id };

  // One transaction per chunk: a single commit for the whole chunk's inserts +
  // enqueues (all on the tx connection). The payload keeps its items untouched
  // throughout, so a crash mid-import re-runs from the stored row (already-
  // inserted rows dedup away).
  const insertChunk = (chunk: ImportItem[]) =>
    db.tx(async (t) => {
      // ON CONFLICT DO NOTHING RETURNING handles a concurrent-import dup on the
      // unique canonical_url without raising — a raised 23505 mid-chunk would
      // abort the whole Postgres transaction (25P02) and lose the chunk.
      const insert = t.prepare(
        `INSERT INTO bookmarks
           (id, url, canonical_url, title, domain, saved_at, saved_from, source_detail, topic_hint, import_batch)
         VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?, ?)
         ON CONFLICT (canonical_url) WHERE canonical_url IS NOT NULL DO NOTHING
         RETURNING id`
      );
      for (const item of chunk) {
        let canonical: string;
        let domain: string;
        try {
          // Pure (no SQL): a bad URL here can't poison the transaction.
          canonical = canonicalize(item.url);
          domain = domainOf(item.url);
        } catch {
          progress.invalid++;
          continue;
        }
        const id = randomUUID();
        const inserted = (await insert.get(
          id,
          item.url,
          canonical,
          item.title,
          domain,
          item.addDate ?? now,
          payload.filename,
          item.folder,
          jobId
        )) as { id: string } | undefined;
        if (inserted) {
          await enqueueJob(t, "enrich", enrichPayload(id));
          progress.imported++;
        } else {
          progress.duplicates++;
        }
      }
    });

  for (let i = 0; i < payload.items.length; i += CHUNK_SIZE) {
    // Stop between chunks on job timeout — the re-run picks up where we left
    // off, and never races a still-running first attempt.
    if (signal?.aborted) throw new Error("import aborted");
    await insertChunk(payload.items.slice(i, i + CHUNK_SIZE));
    await db.prepare("UPDATE jobs SET progress = ? WHERE id = ?").run(JSON.stringify(progress), jobId);
  }
  // Finished: drop the item list, keep the row small.
  await db
    .prepare("UPDATE jobs SET payload = ?, progress = ? WHERE id = ?")
    .run(
      JSON.stringify({ filename: payload.filename, items: [], enrich: payload.enrich }),
      JSON.stringify(progress),
      jobId
    );
}
