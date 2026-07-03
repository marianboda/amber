import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { bearerAuth } from "./auth.js";

const config = loadConfig();
const db = openDb(config.dbPath);

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

const api = new Hono();
api.use("*", bearerAuth(config.authToken));

api.get("/ping", (c) => c.json({ pong: true, device: config.deviceName }));

app.route("/api", api);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`amber server listening on :${info.port}, db at ${config.dbPath}`);
});

export { app, db, config };
