import { Hono } from "hono";
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
import { startWorker } from "./queue.js";
import { enrichBookmark } from "./pipeline/enrich.js";

const config = loadConfig();
const db = openDb(config.dbPath);

startWorker(db, {
  enrich: (payload) => enrichBookmark(db, config, payload.bookmark_id),
});

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

const api = new Hono();
api.use("*", bearerAuth(config.authToken));

api.get("/ping", (c) => c.json({ pong: true, device: config.deviceName }));
api.route("/bookmarks", bookmarkRoutes(db));
api.route("/topics", topicRoutes(db));

app.route("/api", api);

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
