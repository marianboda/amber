import type { Db } from "./db.js";
import PQueue from "p-queue";

export type JobHandler = (payload: any, jobId: string, signal: AbortSignal) => Promise<void>;
// Handlers can carry a per-type timeout (e.g. restore walks a multi-GB zip and
// needs far longer than an enrich fetch).
export type HandlerSpec = JobHandler | { handler: JobHandler; timeoutMs: number };

const MAX_ATTEMPTS = 2;
const JOB_TIMEOUT_MS = 180_000; // wedged handler can't hold a slot forever
const LEASE_SECONDS = 600; // a 'running' row not touched in this long is stale

// Runs the handler with a timeout AND an abort signal, so a timed-out handler
// is told to stop (via signal) rather than left mutating state behind a
// requeue/fail decision.
async function runWithTimeout(
  fn: (signal: AbortSignal) => Promise<void>,
  ms: number
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`job timed out after ${ms}ms`));
    }, ms);
  });
  try {
    await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer!);
    controller.abort(); // ensure the handler's signal fires even on normal finish
  }
}

export interface FailedJob {
  id: string;
  type: string;
  payload: string;
  bookmark_id: string | null;
}

// DB-backed worker: jobs live in the `jobs` table (source of truth), this
// queue is only the executor (design §2). Polls for pending rows, claims each
// atomically with FOR UPDATE SKIP LOCKED so two workers (or overlapping ticks)
// never grab the same row. On boot, running rows are reset to pending so
// nothing is lost across restarts; handlers are idempotent.
export function startWorker(
  db: Db,
  handlers: Record<string, HandlerSpec>,
  {
    concurrency = 2,
    pollMs = 1000,
    jobTimeoutMs = JOB_TIMEOUT_MS,
    onPermanentFailure = undefined as ((job: FailedJob) => Promise<void> | void) | undefined,
  } = {}
): () => Promise<void> {
  const executor = new PQueue({ concurrency });

  const claim = db.prepare(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
     WHERE id = (SELECT id FROM jobs WHERE status = 'pending'
                 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, type, payload, attempts, bookmark_id`
  );
  const finish = db.prepare("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?");
  const requeue = db.prepare("UPDATE jobs SET status = 'pending', updated_at = ? WHERE id = ?");
  const listRunning = db.prepare("SELECT id, type, updated_at FROM jobs WHERE status = 'running'");
  const reclaimOne = db.prepare(
    "UPDATE jobs SET status = 'pending' WHERE id = ? AND status = 'running'"
  );

  const now = () => Math.floor(Date.now() / 1000);

  // The stale-lease cutoff must respect per-type timeouts: a restore allowed
  // to run 30 minutes must not be reclaimed (and run twice concurrently)
  // after the default 10.
  function leaseSecondsFor(type: string): number {
    const spec = handlers[type];
    const timeoutMs = !spec || typeof spec === "function" ? jobTimeoutMs : spec.timeoutMs;
    return Math.max(LEASE_SECONDS, Math.ceil(timeoutMs / 1000) + 60);
  }

  let ticking = false;
  let stopped = false;
  async function tick() {
    if (ticking || stopped) return; // no overlapping polls
    ticking = true;
    try {
      // Reclaim leases from handlers that wedged while the process kept running
      // (no restart needed); idempotent handlers make the re-run safe.
      let stale = 0;
      const running = (await listRunning.all()) as {
        id: string;
        type: string;
        updated_at: number;
      }[];
      for (const job of running) {
        if (now() - job.updated_at > leaseSecondsFor(job.type)) {
          stale += (await reclaimOne.run(job.id)).changes;
        }
      }
      if (stale > 0) console.warn(`queue: reclaimed ${stale} stale running job(s)`);

      while (!stopped && executor.size + executor.pending < concurrency * 2) {
        const job = (await claim.get(now())) as
          | { id: string; type: string; payload: string; attempts: number; bookmark_id: string | null }
          | undefined;
        if (!job) break;
        executor.add(async () => {
          const spec = handlers[job.type];
          try {
            if (!spec) throw new Error(`no handler for job type '${job.type}'`);
            const handler = typeof spec === "function" ? spec : spec.handler;
            const timeoutMs = typeof spec === "function" ? jobTimeoutMs : spec.timeoutMs;
            await runWithTimeout((signal) => handler(JSON.parse(job.payload), job.id, signal), timeoutMs);
            await finish.run("done", null, now(), job.id);
          } catch (err: any) {
            const message = String(err?.message ?? err).slice(0, 500);
            if (job.attempts < MAX_ATTEMPTS) {
              console.warn(`job ${job.id} (${job.type}) failed, will retry: ${message}`);
              await requeue.run(now(), job.id);
            } else {
              console.error(`job ${job.id} (${job.type}) failed permanently: ${message}`);
              await finish.run("failed", message, now(), job.id);
              // Lets the app stamp dependent state terminal (e.g. a bookmark
              // whose enrichment kept timing out stays 'pending' otherwise and
              // would be rescued — and billed for — by maintenance forever).
              try {
                await onPermanentFailure?.(job);
              } catch (hookErr) {
                console.error(`onPermanentFailure hook failed for job ${job.id}:`, hookErr);
              }
            }
          }
        });
      }
    } catch (err) {
      console.error("queue tick error:", err);
    } finally {
      ticking = false;
    }
  }

  // Boot recovery: reset any 'running' rows left by a previous process, then
  // start polling.
  const started = db
    .prepare("UPDATE jobs SET status = 'pending' WHERE status = 'running'")
    .run()
    .then((r) => {
      if (r.changes > 0) console.log(`queue: recovered ${r.changes} interrupted job(s)`);
    })
    .catch((err) => console.error("queue boot recovery failed:", err));

  const interval = setInterval(() => void tick(), pollMs);
  started.then(() => void tick());

  // Stop claiming new jobs, then wait for in-flight ones — a graceful shutdown
  // must not close the DB under a handler mid-write.
  return async () => {
    stopped = true;
    clearInterval(interval);
    executor.clear();
    await executor.onIdle();
  };
}
