import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "node:fs";
import path from "node:path";
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

const config = loadConfig();
const db = openDb(config.dbPath);

startWorker(db, {
  enrich: (payload, _jobId, signal) => enrichBookmark(db, config, payload.bookmark_id, signal),
  import: (payload, jobId) => runImport(db, payload, jobId),
});

// Housekeeping: purge finished jobs, and rescue bookmarks whose deferred
// enrichment never happened (archive_coming save whose snapshot never arrived).
function maintenance() {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM jobs WHERE status = 'done' AND updated_at < ?").run(now - 7 * 86400);
  db.prepare("DELETE FROM jobs WHERE status = 'failed' AND updated_at < ?").run(now - 30 * 86400);
  const orphans = db
    .prepare(
      `SELECT b.id FROM bookmarks b
       WHERE b.enrich_status = 'pending' AND b.saved_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
           WHERE j.type = 'enrich' AND j.status IN ('pending', 'running')
             AND j.payload LIKE '%' || b.id || '%'
         )`
    )
    .all(now - 120) as { id: string }[];
  for (const { id } of orphans) {
    db.prepare(
      `INSERT INTO jobs (id, type, payload, status, attempts, created_at, updated_at)
       VALUES (?, 'enrich', ?, 'pending', 0, ?, ?)`
    ).run(crypto.randomUUID(), JSON.stringify({ bookmark_id: id }), now, now);
  }
  if (orphans.length) console.log(`maintenance: rescued ${orphans.length} orphaned enrichment(s)`);
}
maintenance();
setInterval(maintenance, 60_000);

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

const api = new Hono();
// CORS so the bookmarklet can POST from any page origin. Auth is still the
// bearer token; CORS only lifts the browser's same-origin restriction.
api.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"] }));
api.use("*", bearerAuth(config.authToken));

api.get("/ping", (c) => c.json({ pong: true, device: config.deviceName }));
api.route("/bookmarks", bookmarkRoutes(db, config));
api.route("/topics", topicRoutes(db));
api.route("/import", importRoutes(db));
api.route("/export", exportRoutes(db, config.dataDir));

app.route("/api", api);

// Cached thumbnails/favicons. Served without auth so <img> tags work; paths
// are uuid/hash-named (not enumerable) and contain images only.
app.get("/assets/:kind/:file", (c) => {
  const kind = c.req.param("kind");
  const file = c.req.param("file");
  if (!["thumbs", "favicons"].includes(kind) || !/^[\w.-]+$/.test(file)) {
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
  return c.body(fs.readFileSync(full));
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

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`amber server listening on :${info.port}, db at ${config.dbPath}`);
});

export { app, db, config };
