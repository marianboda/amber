import { Hono } from "hono";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { topicsForBookmark } from "./topics.js";

export function exportRoutes(db: Database.Database, dataDir: string): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const format = c.req.query("format") ?? "json";
    const bookmarks = db.prepare("SELECT * FROM bookmarks ORDER BY saved_at DESC").all() as any[];
    for (const b of bookmarks) b.topics = topicsForBookmark(db, b.id);

    if (format === "zip") {
      // Full backup: metadata JSON + archived pages + cached assets, streamed.
      const topics = db.prepare("SELECT * FROM topics ORDER BY name").all();
      const zip = new ZipArchive({ zlib: { level: 6 } });
      const out = new PassThrough();
      zip.pipe(out);
      zip.append(JSON.stringify({ version: 1, topics, bookmarks }, null, 2), {
        name: "amber-export.json",
      });
      for (const sub of ["archives", "assets"]) {
        const dir = path.join(dataDir, sub);
        if (fs.existsSync(dir)) zip.directory(dir, sub);
      }
      zip.finalize();
      c.header("Content-Type", "application/zip");
      c.header("Content-Disposition", 'attachment; filename="amber-backup.zip"');
      return c.body(Readable.toWeb(out) as ReadableStream);
    }

    if (format === "json") {
      const topics = db.prepare("SELECT * FROM topics ORDER BY name").all();
      c.header("Content-Disposition", 'attachment; filename="amber-export.json"');
      return c.json({ version: 1, topics, bookmarks });
    }

    if (format === "html") {
      c.header("Content-Type", "text/html; charset=utf-8");
      c.header("Content-Disposition", 'attachment; filename="amber-export.html"');
      return c.body(toNetscape(bookmarks));
    }

    return c.json({ error: "format must be json, html or zip" }, 400);
  });

  return app;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Netscape format for re-import anywhere; topics become folders (design §9).
// A bookmark lands in its first topic's folder, topic-less ones at the root.
function toNetscape(bookmarks: any[]): string {
  const byFolder = new Map<string, any[]>();
  const rootItems: any[] = [];
  for (const b of bookmarks) {
    const folder = b.topics[0]?.name;
    if (folder) {
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder)!.push(b);
    } else {
      rootItems.push(b);
    }
  }

  const entry = (b: any) =>
    `        <DT><A HREF="${esc(b.url)}" ADD_DATE="${b.saved_at}">${esc(b.title ?? b.url)}</A>`;

  const folders = [...byFolder.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, items]) =>
        `    <DT><H3>${esc(name)}</H3>\n    <DL><p>\n${items.map(entry).join("\n")}\n    </DL><p>`
    );

  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
${[...folders, ...rootItems.map(entry)].join("\n")}
</DL><p>
`;
}
