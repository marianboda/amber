import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const KEEP = 7;

// Daily consistent DB snapshot via SQLite's online backup API — a raw file
// copy of a live WAL database can miss the -wal file and be inconsistent.
// Archives/assets are plain files and safe to sync as-is; only the DB needs
// this. Returns the snapshot path, or null when today's already exists.
export async function runBackup(
  db: Database.Database,
  dataDir: string,
  keep = KEEP
): Promise<string | null> {
  const dir = path.join(dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `amber-${today}.sqlite`);
  if (fs.existsSync(file)) return null;

  // Write to a temp name first so a crash mid-backup never leaves a plausible-
  // looking but truncated snapshot behind.
  const tmp = `${file}.tmp`;
  await db.backup(tmp);
  fs.renameSync(tmp, file);

  const old = fs
    .readdirSync(dir)
    .filter((f) => /^amber-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
    .sort()
    .slice(0, -keep);
  for (const stale of old) fs.rmSync(path.join(dir, stale), { force: true });
  return file;
}
