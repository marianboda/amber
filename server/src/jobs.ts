import type { Queryable } from "./db.js";
import { randomUUID } from "node:crypto";

export type JobType = "enrich" | "import" | "restore" | "classify";

// Takes a Queryable (pool or tx handle) so a caller inside a transaction can
// enqueue on the same connection and keep the insert atomic with its work.
export async function enqueueJob(
  db: Queryable,
  type: JobType,
  payload: Record<string, unknown>
): Promise<string> {
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  // bookmark_id is denormalized into its own column so the maintenance sweep
  // and ops queries can join on it instead of LIKE-scanning JSON payloads.
  const bookmarkId = typeof payload.bookmark_id === "string" ? payload.bookmark_id : null;
  await db
    .prepare(
      `INSERT INTO jobs (id, type, payload, status, attempts, created_at, updated_at, bookmark_id)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`
    )
    .run(id, type, JSON.stringify(payload), now, now, bookmarkId);
  return id;
}
