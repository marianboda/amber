import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import type { Config } from "../src/config.js";
import { bookmarkRoutes } from "../src/routes/bookmarks.js";
import { decodeHtml } from "../src/pipeline/fetcher.js";
import { injectBase } from "../src/pipeline/archive-fallback.js";

let dir: string;
let db: ReturnType<typeof openDb>;
let app: Hono;

beforeAll(() => {
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

  const insert = db.prepare(
    `INSERT INTO bookmarks (id, url, canonical_url, domain, saved_at, enrich_status, title, content_text)
     VALUES (?, ?, ?, ?, ?, 'done', ?, ?)`
  );
  // Older row matches in the TITLE, newer row only deep in content — relevance
  // must put the title hit first despite recency.
  insert.run(
    "old-title-hit",
    "https://a.test/rust-book",
    "https://a.test/rust-book",
    "a.test",
    1000,
    "The Rust Programming Language",
    "a book about systems programming"
  );
  insert.run(
    "new-content-hit",
    "https://b.test/misc",
    "https://b.test/misc",
    "b.test",
    9000,
    "Weekly links",
    `${"filler words ".repeat(200)} one mention of rust near the end`
  );
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("relevance search", () => {
  it("ranks title matches above content matches and returns snippets", async () => {
    const res = await (await app.request("/bookmarks?q=rust")).json();
    expect(res.bookmarks.map((b: any) => b.id)).toEqual(["old-title-hit", "new-content-hit"]);
    expect(res.next_before).toBeNull();
    const contentHit = res.bookmarks[1];
    expect(contentHit.snippet).toContain("<mark>rust</mark>");
  });

  it("sort=recent restores date order and the cursor", async () => {
    const res = await (await app.request("/bookmarks?q=rust&sort=recent")).json();
    expect(res.bookmarks.map((b: any) => b.id)).toEqual(["new-content-hit", "old-title-hit"]);
  });
});

describe("decodeHtml", () => {
  it("decodes ISO-8859-2 from the Content-Type header", () => {
    // "čaj" in ISO-8859-2: č=0xE8, a=0x61, j=0x6A
    const bytes = Buffer.from([0xe8, 0x61, 0x6a]);
    expect(decodeHtml(bytes, "text/html; charset=ISO-8859-2")).toBe("čaj");
    // utf8 misdecode would produce replacement chars:
    expect(decodeHtml(bytes, "text/html")).not.toBe("čaj");
  });

  it("sniffs <meta charset> when the header is silent", () => {
    const body = Buffer.concat([
      Buffer.from('<html><head><meta charset="iso-8859-2"></head><body>'),
      Buffer.from([0xe8]),
      Buffer.from("aj</body></html>"),
    ]);
    expect(decodeHtml(body, "text/html")).toContain("čaj");
  });

  it("defaults to utf-8", () => {
    expect(decodeHtml(Buffer.from("héllo", "utf8"), "text/html")).toBe("héllo");
  });
});

describe("injectBase", () => {
  it("inserts <base> after <head>", () => {
    const out = injectBase("<html><head><title>x</title></head><body></body></html>", "https://e.test/page");
    expect(out).toContain('<head><base href="https://e.test/page">');
  });

  it("respects an existing <base> and handles head-less html", () => {
    const existing = '<html><head><base href="https://orig/"></head></html>';
    expect(injectBase(existing, "https://e.test/")).toBe(existing);
    expect(injectBase("<p>bare</p>", "https://e.test/")).toBe('<base href="https://e.test/"><p>bare</p>');
  });
});
