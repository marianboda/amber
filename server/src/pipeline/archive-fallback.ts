import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scrubScripts } from "../routes/bookmarks.js";

const execFileAsync = promisify(execFile);

let monolithChecked = false;
let monolithAvailable = false;

async function hasMonolith(): Promise<boolean> {
  if (!monolithChecked) {
    monolithChecked = true;
    try {
      await execFileAsync("monolith", ["--version"], { timeout: 5000 });
      monolithAvailable = true;
      console.log("archive fallback: monolith found, using self-contained snapshots");
    } catch {
      monolithAvailable = false;
    }
  }
  return monolithAvailable;
}

// Server-side archival for saves that didn't come through the extension
// (bookmarklet, API, import, share sheet). Prefers monolith (self-contained,
// assets inlined) when installed; falls back to the raw fetched HTML, which
// preserves the text even if styling/images later rot.
export async function archiveFallback(
  db: Database.Database,
  dataDir: string,
  bookmarkId: string,
  url: string,
  rawHtml: string
): Promise<void> {
  const dir = path.join(dataDir, "archives");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${bookmarkId}.html`);

  let html = rawHtml;
  if (await hasMonolith()) {
    try {
      const { stdout } = await execFileAsync(
        "monolith",
        ["--no-js", "--isolate", "--silent", url],
        { timeout: 90_000, maxBuffer: 300 * 1024 * 1024 }
      );
      if (stdout && stdout.length > 200) html = stdout;
    } catch {
      // monolith failed (JS-heavy page, timeout) — raw HTML still gets stored
    }
  }

  fs.writeFileSync(file, scrubScripts(html));
  db.prepare("UPDATE bookmarks SET archive_ref = ? WHERE id = ?").run(
    `archives/${bookmarkId}.html`,
    bookmarkId
  );
}
