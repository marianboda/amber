import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scrubScripts } from "../routes/bookmarks.js";

const execFileAsync = promisify(execFile);

// Point relative asset URLs back at the original origin. Respects an existing
// <base>; otherwise inserts one right after <head> (or prepends).
export function injectBase(html: string, url: string): string {
  if (/<base\s/i.test(html)) return html;
  const safeUrl = url.replace(/"/g, "&quot;");
  const tag = `<base href="${safeUrl}">`;
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch && headMatch.index !== undefined) {
    const at = headMatch.index + headMatch[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

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
//
// SSRF: monolith is fed the ALREADY-GUARDED HTML from a local temp file with
// --base-url, so it never re-fetches the primary URL — a redirect/DNS-rebind
// on that URL can't slip past the connect-pinned fetch that produced rawHtml.
// (monolith still fetches sub-resources against base-url; that surface is
// bounded to a public page's own assets and is why it stays opt-in via PATH.)
//
// Returns true if an archive file was written, false otherwise. Never throws —
// archival is best-effort and must not fail enrichment.
export async function archiveFallback(
  db: Database.Database,
  dataDir: string,
  bookmarkId: string,
  url: string,
  rawHtml: string
): Promise<boolean> {
  try {
    const dir = path.join(dataDir, "archives");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${bookmarkId}.html`);

    let html = rawHtml;
    let usedMonolith = false;
    if (await hasMonolith()) {
      const tmpDir = path.join(dataDir, "tmp");
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmp = path.join(tmpDir, `${randomUUID()}.html`);
      try {
        fs.writeFileSync(tmp, rawHtml);
        const { stdout } = await execFileAsync(
          "monolith",
          ["--no-js", "--isolate", "--silent", "--base-url", url, tmp],
          { timeout: 90_000, maxBuffer: 300 * 1024 * 1024 }
        );
        if (stdout && stdout.length > 200) {
          html = stdout;
          usedMonolith = true;
        }
      } catch {
        // monolith failed (timeout, sub-resource error) — raw HTML still stored
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    // Raw (non-monolith) fallback keeps the page's relative asset URLs — served
    // from Amber's origin they'd all 404 without a <base>.
    if (!usedMonolith) html = injectBase(html, url);

    fs.writeFileSync(file, scrubScripts(html));
    db.prepare("UPDATE bookmarks SET archive_ref = ? WHERE id = ?").run(
      `archives/${bookmarkId}.html`,
      bookmarkId
    );
    return true;
  } catch (err) {
    console.warn(`archive fallback failed for ${bookmarkId}: ${String(err)}`);
    return false;
  }
}
