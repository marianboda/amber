import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type JobType = "enrich" | "import" | "classify";

export function enqueueJob(
  db: Database.Database,
  type: JobType,
  payload: Record<string, unknown>
): string {
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO jobs (id, type, payload, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?)`
  ).run(id, type, JSON.stringify(payload), now, now);
  return id;
}
