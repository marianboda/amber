import type { Db } from "../db.js";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

export interface RestorePayload {
  // Path relative to dataDir — an uploaded amber-backup.zip or amber-export.json
  // staged under tmp/ by the import route.
  file: string;
  filename: string;
}

// Columns restored verbatim. Everything user- or pipeline-generated survives a
// round trip; unknown extra keys in the export are ignored.
const BOOKMARK_COLUMNS = [
  "id",
  "url",
  "canonical_url",
  "title",
  "domain",
  "favicon_url",
  "og_image_url",
  "saved_at",
  "content_type",
  "gist",
  "summary",
  "note",
  "is_read",
  "saved_from",
  "device",
  "referrer",
  "source_detail",
  "topic_hint",
  "enrich_status",
  "fetch_status",
  "content_text",
  "content_html",
  "archive_ref",
  "media_ref",
  "media_status",
  "title_locked",
  "import_batch",
] as const;

// Only these zip entries are extracted, and only with sane one-level names —
// a hostile zip must not be able to write outside dataDir (zip slip).
const SAFE_ENTRY = /^(archives|assets\/(?:thumbs|favicons))\/[\w][\w.-]*$/;

// Restored metadata is data too: refs are only honored when they point at the
// shapes Amber itself writes, so a crafted export can't smuggle "../../"
// paths into later archive serving/deletion.
const SAFE_ARCHIVE_REF = /^archives\/[\w][\w.-]*$/;
const SAFE_MEDIA_REF = /^media\/[\w][\w.-]*$/;
const SAFE_ASSET_URL = /^\/assets\/(?:thumbs|favicons)\/[\w][\w.-]*$/;

function safeRef(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function safeAssetUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^https?:\/\//.test(value) || SAFE_ASSET_URL.test(value)) return value;
  return null;
}

// Zip-bomb limits: the 4GB cap on the *compressed* upload says nothing about
// what it inflates to.
const MAX_JSON_ENTRY = 1024 * 1024 * 1024; // 1GB metadata JSON
const MAX_FILE_ENTRY = 512 * 1024 * 1024; // archives are capped at 300MB at write time
const MAX_TOTAL_EXTRACTED = 20 * 1024 * 1024 * 1024; // 20GB across all entries

export interface RestoreProgress {
  bookmarks_restored: number;
  bookmarks_skipped: number;
  topics_restored: number;
  files_restored: number;
  files_skipped: number;
}

// Restores an Amber JSON export (and, for zips, archived pages + cached
// assets). Idempotent: existing ids/canonical URLs and existing files are
// skipped, so a crashed restore can simply re-run.
export async function runRestore(
  db: Db,
  dataDir: string,
  payload: RestorePayload,
  jobId: string,
  signal?: AbortSignal
): Promise<void> {
  const file = path.join(dataDir, payload.file);
  const progress: RestoreProgress = {
    bookmarks_restored: 0,
    bookmarks_skipped: 0,
    topics_restored: 0,
    files_restored: 0,
    files_skipped: 0,
  };

  const isZip = await fileIsZip(file);
  if (isZip) {
    const json = await extractZip(file, dataDir, progress, signal);
    if (json === null) throw new Error("backup zip has no amber-export.json");
    await restoreMetadata(db, json, progress);
  } else {
    await restoreMetadata(db, JSON.parse(fs.readFileSync(file, "utf8")), progress);
  }

  await db.prepare("UPDATE jobs SET progress = ? WHERE id = ?").run(JSON.stringify(progress), jobId);
  fs.rmSync(file, { force: true }); // staged upload no longer needed
}

async function fileIsZip(file: string): Promise<boolean> {
  const fd = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(4);
    await fd.read(buf, 0, 4, 0);
    return buf.toString("latin1").startsWith("PK");
  } finally {
    await fd.close();
  }
}

// Walks the zip, streaming archives/assets straight to disk (never buffering a
// 300MB archive in memory) and returning the parsed metadata JSON.
function extractZip(
  zipPath: string,
  dataDir: string,
  progress: RestoreProgress,
  signal?: AbortSignal
): Promise<any | null> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("unreadable zip"));
      let json: any = null;
      let totalExtracted = 0;
      zip.on("error", reject);
      zip.on("end", () => resolve(json));
      zip.on("entry", (entry: yauzl.Entry) => {
        if (signal?.aborted) {
          zip.close();
          return reject(new Error("restore aborted"));
        }
        const name = entry.fileName;
        const handleNext = () => zip.readEntry();

        if (name === "amber-export.json") {
          if (entry.uncompressedSize > MAX_JSON_ENTRY) {
            return reject(new Error("backup metadata JSON too large"));
          }
          zip.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) return reject(streamErr ?? new Error("bad zip entry"));
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on("data", (c: Buffer) => {
              size += c.length;
              if (size > MAX_JSON_ENTRY) {
                stream.destroy();
                return reject(new Error("backup metadata JSON too large"));
              }
              chunks.push(c);
            });
            stream.on("error", reject);
            stream.on("end", () => {
              try {
                json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              } catch (parseErr) {
                return reject(parseErr);
              }
              handleNext();
            });
          });
          return;
        }

        if (!SAFE_ENTRY.test(name) || name.endsWith("/")) {
          return handleNext(); // directory rows and anything unexpected
        }
        // Inflation caps: a tiny compressed zip must not OOM memory or fill
        // the disk (yauzl verifies the declared sizes against the stream).
        if (entry.uncompressedSize > MAX_FILE_ENTRY) {
          progress.files_skipped++;
          return handleNext();
        }
        totalExtracted += entry.uncompressedSize;
        if (totalExtracted > MAX_TOTAL_EXTRACTED) {
          return reject(new Error("backup inflates beyond the extraction cap"));
        }
        const dest = path.join(dataDir, name);
        if (fs.existsSync(dest)) {
          progress.files_skipped++;
          return handleNext();
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error("bad zip entry"));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          // Write to a temp name, rename when complete — a crash mid-stream
          // must not leave a truncated file that later re-runs treat as done.
          const tmp = `${dest}.restoretmp`;
          pipeline(stream as unknown as Readable, fs.createWriteStream(tmp))
            .then(() => {
              fs.renameSync(tmp, dest);
              progress.files_restored++;
              handleNext();
            })
            .catch((pipeErr) => {
              fs.rmSync(tmp, { force: true });
              reject(pipeErr);
            });
        });
      });
      zip.readEntry();
    });
  });
}

async function restoreMetadata(db: Db, data: any, progress: RestoreProgress) {
  if (!data || data.version !== 1 || !Array.isArray(data.bookmarks)) {
    throw new Error("not an amber export (expected version 1 with a bookmarks array)");
  }

  const topicIdByName = new Map<string, string>();
  await db.tx(async (t) => {
    const findTopic = t.prepare("SELECT id FROM topics WHERE name = ?");
    const insertTopic = t.prepare("INSERT INTO topics (id, name, color) VALUES (?, ?, ?)");
    const findById = t.prepare("SELECT id FROM bookmarks WHERE id = ?");
    const findByCanonical = t.prepare("SELECT id FROM bookmarks WHERE canonical_url = ?");
    const insertBookmark = t.prepare(
      `INSERT INTO bookmarks (${BOOKMARK_COLUMNS.join(",")})
       VALUES (${BOOKMARK_COLUMNS.map(() => "?").join(",")})`
    );
    const linkTopic = t.prepare(
      "INSERT INTO bookmark_topics (bookmark_id, topic_id, by_ai) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"
    );

    for (const topic of data.topics ?? []) {
      if (!topic?.name) continue;
      const existing = (await findTopic.get(topic.name)) as { id: string } | undefined;
      if (existing) {
        topicIdByName.set(topic.name, existing.id);
      } else {
        const id = typeof topic.id === "string" ? topic.id : crypto.randomUUID();
        await insertTopic.run(id, topic.name, topic.color ?? null);
        topicIdByName.set(topic.name, id);
        progress.topics_restored++;
      }
    }

    for (const b of data.bookmarks) {
      if (!b?.id || !b?.url || typeof b.saved_at !== "number") {
        progress.bookmarks_skipped++;
        continue;
      }
      // First-seen wins, same as every other save path: an id or canonical
      // URL already in the library keeps its existing row.
      if ((await findById.get(b.id)) || (b.canonical_url && (await findByCanonical.get(b.canonical_url)))) {
        progress.bookmarks_skipped++;
        continue;
      }
      const sanitized: Record<string, unknown> = {
        ...b,
        archive_ref: safeRef(b.archive_ref, SAFE_ARCHIVE_REF),
        media_ref: safeRef(b.media_ref, SAFE_MEDIA_REF),
        og_image_url: safeAssetUrl(b.og_image_url),
        favicon_url: safeAssetUrl(b.favicon_url),
        // NOT NULL columns — hand-trimmed exports may omit them.
        is_read: b.is_read ?? 0,
        title_locked: b.title_locked ?? 0,
        enrich_status: b.enrich_status ?? "pending",
        fetch_status: b.fetch_status ?? "pending",
      };
      await insertBookmark.run(...BOOKMARK_COLUMNS.map((col) => sanitized[col] ?? null));
      progress.bookmarks_restored++;
      for (const topic of b.topics ?? []) {
        const topicId =
          topicIdByName.get(topic?.name) ?? ((await findTopic.get(topic?.name ?? "")) as any)?.id;
        if (topicId) await linkTopic.run(b.id, topicId, topic.by_ai ?? 0);
      }
    }
  });
}
