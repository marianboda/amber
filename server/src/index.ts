import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { bearerAuth } from "./auth.js";
import { bookmarkRoutes } from "./routes/bookmarks.js";
import { topicRoutes } from "./routes/topics.js";
import { importRoutes } from "./routes/import.js";
import { exportRoutes } from "./routes/export.js";
import { startWorker } from "./queue.js";
import { enrichBookmark } from "./pipeline/enrich.js";
import { runImport } from "./import/run.js";
import { runMaintenance } from "./maintenance.js";
import { runRestore } from "./import/restore.js";
import { runBackup } from "./backup.js";
import { opsRoutes } from "./routes/ops.js";

const config = loadConfig();
const db = openDb(config.dbPath);

const stopWorker = startWorker(
  db,
  {
    enrich: (payload, _jobId, signal) =>
      enrichBookmark(db, config, payload.bookmark_id, signal, payload.mode),
    import: (payload, jobId, signal) => runImport(db, payload, jobId, signal),
    // Restores walk a potentially multi-GB backup zip — give them a real budget.
    restore: {
      handler: (payload, jobId, signal) => runRestore(db, config.dataDir, payload, jobId, signal),
      timeoutMs: 30 * 60_000,
    },
  },
  {
    // A permanently-failed enrichment must surface as a failed bookmark:
    // leaving it 'pending' would strand the UI shimmer and make the
    // maintenance sweep re-enqueue (and re-bill) it forever.
    onPermanentFailure: (job) => {
      if (job.type === "enrich" && job.bookmark_id) {
        db.prepare(
          "UPDATE bookmarks SET enrich_status = 'failed' WHERE id = ? AND enrich_status = 'pending'"
        ).run(job.bookmark_id);
      }
    },
  }
);

function maintenance() {
  const rescued = runMaintenance(db, config.dataDir);
  if (rescued) console.log(`maintenance: rescued ${rescued} orphaned enrichment(s)`);
}
maintenance();
const maintenanceTimer = setInterval(maintenance, 60_000);

// Daily consistent DB snapshot (runBackup no-ops when today's exists).
function backup() {
  runBackup(db, config.dataDir)
    .then((file) => file && console.log(`backup: wrote ${file}`))
    .catch((err) => console.error("backup failed:", err));
}
backup();
const backupTimer = setInterval(backup, 3600_000);

const app = new Hono();

app.onError((err, c) => {
  console.error(`unhandled error on ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: "internal error" }, 500);
});

app.get("/health", (c) => {
  try {
    db.prepare("SELECT 1").get();
    return c.json({ ok: true });
  } catch (err) {
    console.error("health check failed:", err);
    return c.json({ ok: false }, 500);
  }
});

const api = new Hono();
// CORS so the bookmarklet can POST from any page origin. Auth is still the
// bearer token; CORS only lifts the browser's same-origin restriction.
api.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"] }));
api.use("*", bearerAuth(config.authToken));
// Notes/content must not linger in shared caches or on shared machines.
api.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

api.get("/ping", (c) => c.json({ pong: true, device: config.deviceName }));
api.route("/bookmarks", bookmarkRoutes(db, config));
api.route("/topics", topicRoutes(db));
api.route("/import", importRoutes(db, config.dataDir));
api.route("/export", exportRoutes(db, config.dataDir));
api.route("/", opsRoutes(db, config.dataDir));

app.route("/api", api);

// Cached thumbnails/favicons. Served without auth so <img> tags work; paths
// are uuid/hash-named (not enumerable) and contain images only.
app.get("/assets/:kind/:file", (c) => {
  const kind = c.req.param("kind");
  const file = c.req.param("file");
  // Leading dot rejected: "."/".." resolve to directories and 500.
  if (!["thumbs", "favicons"].includes(kind) || !/^[A-Za-z0-9][\w.-]*$/.test(file)) {
    return c.json({ error: "bad path" }, 400);
  }
  const full = path.join(config.dataDir, "assets", kind, file);
  if (!fs.existsSync(full)) return c.json({ error: "not found" }, 404);
  const ext = file.split(".").pop() ?? "";
  const types: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif", img: "application/octet-stream",
  };
  c.header("Content-Type", types[ext] ?? "application/octet-stream");
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  // SVGs from untrusted pages are active content — neutralize direct opens.
  c.header("Content-Security-Policy", "sandbox; script-src 'none'");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(Readable.toWeb(fs.createReadStream(full)) as ReadableStream);
});

// Web UI: serve the built Svelte app when web/dist exists (repo layout or Docker).
const webDist = ["../../web/dist", "../web/dist"]
  .map((rel) => path.join(path.dirname(fileURLToPath(import.meta.url)), rel))
  .find((p) => fs.existsSync(path.join(p, "index.html")));
if (webDist) {
  const root = path.relative(process.cwd(), webDist);
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
  console.log(`serving web UI from ${webDist}`);
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`amber server listening on :${info.port}, db at ${config.dbPath}`);
});

// Graceful shutdown: stop claiming jobs, let in-flight ones finish (they're
// resumable anyway, but a clean DB close checkpoints the WAL), then exit.
let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${sig} received, shutting down`);
  clearInterval(maintenanceTimer);
  clearInterval(backupTimer);
  server.close(() => {});
  // Don't wait forever on a wedged handler — its job re-runs on next boot.
  await Promise.race([stopWorker(), new Promise((r) => setTimeout(r, 10_000))]);
  try {
    db.close();
  } catch (err) {
    console.error("db close failed:", err);
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export { app, db, config };
