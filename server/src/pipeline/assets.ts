import type { Queryable } from "../db.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fetchAsset } from "./fetcher.js";

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/avif": "avif",
};

function extensionFor(contentType: string, url: string): string {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (EXT_BY_TYPE[type]) return EXT_BY_TYPE[type];
  const fromUrl = url.split("?")[0].match(/\.(png|jpe?g|webp|gif|svg|ico|avif)$/i)?.[1];
  return (fromUrl ?? "img").toLowerCase().replace("jpeg", "jpg");
}

// Permanence for card visuals (design principle 5): og images and favicons
// are downloaded at enrich time and served locally, so cards survive link rot.
// Local paths start with /assets/ and are stored in the same columns the UI
// already reads; anything still http(s) simply wasn't cacheable.
export async function cacheAssets(db: Queryable, dataDir: string, bookmarkId: string) {
  const row = (await db
    .prepare("SELECT og_image_url, favicon_url, domain FROM bookmarks WHERE id = ?")
    .get(bookmarkId)) as
    | { og_image_url: string | null; favicon_url: string | null; domain: string | null }
    | undefined;
  if (!row) return;

  if (row.og_image_url?.startsWith("http")) {
    const asset = await fetchAsset(row.og_image_url);
    if (asset) {
      const file = `thumbs/${bookmarkId}.${extensionFor(asset.contentType, row.og_image_url)}`;
      writeAsset(dataDir, file, asset.bytes);
      await db
        .prepare("UPDATE bookmarks SET og_image_url = ? WHERE id = ?")
        .run(`/assets/${file}`, bookmarkId);
    }
  }

  if (row.favicon_url?.startsWith("http")) {
    // Favicons dedup by domain; hashed filename avoids domain enumeration.
    const hash = createHash("sha1").update(row.favicon_url).digest("hex").slice(0, 16);
    const ext = extensionFor("", row.favicon_url);
    const file = `favicons/${hash}.${ext === "img" ? "ico" : ext}`;
    if (!fs.existsSync(path.join(dataDir, "assets", file))) {
      const asset = await fetchAsset(row.favicon_url);
      if (!asset) return;
      writeAsset(dataDir, file, asset.bytes);
    }
    await db
      .prepare("UPDATE bookmarks SET favicon_url = ? WHERE domain = ? AND favicon_url = ?")
      .run(`/assets/${file}`, row.domain, row.favicon_url);
  }
}

function writeAsset(dataDir: string, relative: string, bytes: Buffer) {
  const file = path.join(dataDir, "assets", relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
