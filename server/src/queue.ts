import type Database from "better-sqlite3";
import PQueue from "p-queue";

export type JobHandler = (payload: any, jobId: string) => Promise<void>;

const MAX_ATTEMPTS = 2;

// DB-backed worker: jobs live in the `jobs` table (source of truth), this
// queue is only the executor (design §2). Polls for pending rows, claims by
// flipping status to running. On boot, running rows are reset to pending so
// nothing is lost across restarts; handlers are idempotent.
export function startWorker(
  db: Database.Database,
  handlers: Record<string, JobHandler>,
  { concurrency = 2, pollMs = 1000 } = {}
): () => void {
  const executor = new PQueue({ concurrency });

  const recovered = db
    .prepare("UPDATE jobs SET status = 'pending' WHERE status = 'running'")
    .run().changes;
  if (recovered > 0) console.log(`queue: recovered ${recovered} interrupted job(s)`);

  const claim = db.prepare(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
     WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1)
     RETURNING id, type, payload, attempts`
  );
  const finish = db.prepare("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?");
  const requeue = db.prepare("UPDATE jobs SET status = 'pending', updated_at = ? WHERE id = ?");

  const now = () => Math.floor(Date.now() / 1000);

  function tick() {
    while (executor.size + executor.pending < concurrency * 2) {
      const job = claim.get(now()) as
        | { id: string; type: string; payload: string; attempts: number }
        | undefined;
      if (!job) break;
      executor.add(async () => {
        const handler = handlers[job.type];
        try {
          if (!handler) throw new Error(`no handler for job type '${job.type}'`);
          await handler(JSON.parse(job.payload), job.id);
          finish.run("done", null, now(), job.id);
        } catch (err: any) {
          const message = String(err?.message ?? err).slice(0, 500);
          if (job.attempts < MAX_ATTEMPTS) {
            console.warn(`job ${job.id} (${job.type}) failed, will retry: ${message}`);
            requeue.run(now(), job.id);
          } else {
            console.error(`job ${job.id} (${job.type}) failed permanently: ${message}`);
            finish.run("failed", message, now(), job.id);
          }
        }
      });
    }
  }

  const interval = setInterval(tick, pollMs);
  tick();
  return () => clearInterval(interval);
}
