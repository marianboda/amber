import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import type { Config } from "../src/config.js";
import { bookmarkRoutes } from "../src/routes/bookmarks.js";

let dir: string;
let db: ReturnType<typeof openDb>;
let app: Hono;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-test-"));
  db = openDb(path.join(dir, "test.sqlite"));
  const config: Config = {
    port: 0,
    dataDir: dir,
    dbPath: path.join(dir, "test.sqlite"),
    authToken: "t",
    llm: { provider: "none", apiKey: "", model: "" },
    geminiApiKey: "",
    deviceName: "test",
  };
  app = new Hono();
  app.route("/bookmarks", bookmarkRoutes(db, config));
  // Three bookmarks across two domains with distinct saved_at.
  const insert = db.prepare(
    `INSERT INTO bookmarks (id, url, canonical_url, domain, saved_at, enrich_status)
     VALUES (?, ?, ?, ?, ?, 'done')`
  );
  insert.run("b1", "https://one.test/a", "https://one.test/a", "one.test", 1000);
  insert.run("b2", "https://two.test/b", "https://two.test/b", "two.test", 2000);
  insert.run("b3", "https://one.test/c", "https://one.test/c", "one.test", 3000);
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("batched status", () => {
  it("returns statuses for requested ids only", async () => {
    const res = await (await app.request("/bookmarks/status?ids=b1,b3,ghost")).json();
    expect(res.statuses.map((s: any) => s.id).sort()).toEqual(["b1", "b3"]);
    expect(res.statuses[0]).toHaveProperty("enrich_status");
  });

  it("handles an empty ids list", async () => {
    const res = await (await app.request("/bookmarks/status?ids=")).json();
    expect(res.statuses).toEqual([]);
  });
});

describe("domain filter", () => {
  it("filters by exact domain", async () => {
    const res = await (await app.request("/bookmarks?domain=one.test")).json();
    expect(res.bookmarks.map((b: any) => b.id).sort()).toEqual(["b1", "b3"]);
  });
});

describe("oldest-first sort", () => {
  it("orders ascending and pages with the after cursor", async () => {
    const page1 = await (await app.request("/bookmarks?sort=oldest&limit=2")).json();
    expect(page1.bookmarks.map((b: any) => b.id)).toEqual(["b1", "b2"]);
    expect(page1.next_before).toBeNull();
    expect(page1.next_after).toBe("2000.b2");
    const page2 = await (
      await app.request(`/bookmarks?sort=oldest&limit=2&after=${page1.next_after}`)
    ).json();
    expect(page2.bookmarks.map((b: any) => b.id)).toEqual(["b3"]);
  });

  it("default sort still pages newest-first with before cursor", async () => {
    const page1 = await (await app.request("/bookmarks?limit=2")).json();
    expect(page1.bookmarks.map((b: any) => b.id)).toEqual(["b3", "b2"]);
    expect(page1.next_before).toBe("2000.b2");
    const page2 = await (await app.request(`/bookmarks?limit=2&before=${page1.next_before}`)).json();
    expect(page2.bookmarks.map((b: any) => b.id)).toEqual(["b1"]);
  });
});
