import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KEEP = 7;

let pgDumpChecked = false;
let pgDumpAvailable = false;

async function hasPgDump(): Promise<boolean> {
  if (!pgDumpChecked) {
    pgDumpChecked = true;
    try {
      await execFileAsync("pg_dump", ["--version"], { timeout: 5000 });
      pgDumpAvailable = true;
    } catch {
      pgDumpAvailable = false;
      console.warn("backup: pg_dump not on PATH — scheduled DB snapshots disabled");
    }
  }
  return pgDumpAvailable;
}

// Daily consistent DB snapshot via pg_dump (custom format, gzip). Archives and
// cached assets are plain files on the mount and safe to sync as-is; only the
// metadata database needs a dump. Returns the snapshot path, or null when
// today's already exists or pg_dump is unavailable.
export async function runBackup(
  databaseUrl: string,
  dataDir: string,
  keep = KEEP
): Promise<string | null> {
  if (!(await hasPgDump())) return null;
  const dir = path.join(dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `amber-${today}.dump`);
  if (fs.existsSync(file)) return null;

  // Write to a temp name first so a crash mid-backup never leaves a plausible-
  // looking but truncated snapshot behind. -Fc = custom format (restore with
  // pg_restore), -Z6 = gzip level 6.
  const tmp = `${file}.tmp`;
  await execFileAsync("pg_dump", ["-Fc", "-Z", "6", "-f", tmp, databaseUrl], {
    timeout: 30 * 60_000,
  });
  fs.renameSync(tmp, file);

  const old = fs
    .readdirSync(dir)
    .filter((f) => /^amber-\d{4}-\d{2}-\d{2}\.dump$/.test(f))
    .sort()
    .slice(0, -keep);
  for (const stale of old) fs.rmSync(path.join(dir, stale), { force: true });
  return file;
}
