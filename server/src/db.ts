import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool, types } = pg;

// int8/bigint (OID 20) and count() come back as strings by default; parse to
// JS numbers so timestamp arithmetic and COUNT(*) results behave like they did
// under better-sqlite3. Safe below 2^53 (unix seconds, row counts).
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

// Translate better-sqlite3 '?' placeholders to Postgres '$n'. Only '?' in
// ordinary SQL is rewritten — '?' inside single-quoted strings, double-quoted
// identifiers, dollar-quoted strings ($tag$…$tag$), line comments (-- …), and
// block comments (/* … */) is left alone, so the adapter is safe for real
// Postgres syntax, not just the queries in this repo.
export function translate(sql: string): string {
  let out = "";
  let n = 0;
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (ch === "'" || ch === '"') {
      // Quoted literal/identifier; doubled quote is an escape, not a terminator.
      const q = ch;
      out += ch;
      i++;
      while (i < len) {
        if (sql[i] === q && sql[i + 1] === q) {
          out += q + q;
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? len : nl;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (two === "/*") {
      const close = sql.indexOf("*/", i + 2);
      const end = close === -1 ? len : close + 2;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "$") {
      // Dollar-quoted string: $tag$ ... $tag$ (tag may be empty).
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tag) {
        const open = tag[0];
        const close = sql.indexOf(open, i + open.length);
        const end = close === -1 ? len : close + open.length;
        out += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    if (ch === "?") {
      out += "$" + ++n;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export interface Statement {
  get(...params: any[]): Promise<any>;
  all(...params: any[]): Promise<any[]>;
  run(...params: any[]): Promise<{ changes: number }>;
}

// A prepared-statement handle bound to a query executor (the pool, or a single
// client inside a transaction). Mirrors the better-sqlite3 get/all/run surface
// so call sites only gain `await`.
function makeStatement(exec: (text: string, params: any[]) => Promise<pg.QueryResult>, sql: string): Statement {
  const text = translate(sql);
  return {
    async get(...params) {
      return (await exec(text, params)).rows[0];
    },
    async all(...params) {
      return (await exec(text, params)).rows;
    },
    async run(...params) {
      const r = await exec(text, params);
      return { changes: r.rowCount ?? 0 };
    },
  };
}

// A read/write executor: the pool wrapper and a transaction handle both satisfy
// this, so helpers can run against either.
export interface Queryable {
  prepare(sql: string): Statement;
}

export interface Db extends Queryable {
  tx<T>(fn: (t: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  end(): Promise<void>;
  readonly pool: pg.Pool;
}

export async function openDb(databaseUrl: string, opts: { schema?: string } = {}): Promise<Db> {
  // A dedicated schema (test isolation) is set as a connection startup option,
  // so every pooled connection gets it with no extra round-trip or race.
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 8,
    ...(opts.schema ? { options: `-c search_path=${opts.schema},public` } : {}),
  });
  if (opts.schema) {
    const bootstrap = await pool.connect();
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${opts.schema}`);
    } finally {
      bootstrap.release();
    }
  }

  const db: Db = {
    pool,
    prepare(sql) {
      return makeStatement((text, params) => pool.query(text, params), sql);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const handle: Queryable = {
          prepare(sql) {
            return makeStatement((text, params) => client.query(text, params), sql);
          },
        };
        const result = await fn(handle);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      // Multi-statement DDL (migrations) — no params, simple query protocol.
      // search_path already applied via the pool's startup options.
      await pool.query(sql);
    },
    async end() {
      await pool.end();
    },
  };

  try {
    await migrate(db);
  } catch (err) {
    // Don't leak the pool (idle connections + timers) when startup fails.
    await pool.end().catch(() => {});
    throw err;
  }
  return db;
}

// Arbitrary constant identifying the amber migration lock (advisory locks are
// keyed globally per database).
const MIGRATION_LOCK_KEY = 4_021_970_111;

async function migrate(db: Db) {
  // Hold a session advisory lock for the whole discover+apply so two instances
  // booting at once (rolling deploy) can't both try to apply the same
  // migration — the second blocks, then reads schema_migrations and skips.
  const client = await db.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)"
    );
    const { rows } = await client.query("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name));
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      // Migration files are multi-statement DDL — simple query protocol
      // (parameterized rejects multiple statements), wrapped in a transaction
      // so a bad migration rolls back.
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [
          file,
          Math.floor(Date.now() / 1000),
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
      console.log(`migrated: ${file}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
