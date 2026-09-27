// @ts-nocheck
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config/env.js";
import * as sqliteSchema from "./schema.js";
import * as pgSchema from "./schema.pg.js";

function isPostgres(url: string): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

function createSqliteClient() {
  const databaseUrl = config.databaseUrl;
  const filePath = databaseUrl.startsWith("sqlite:") ? databaseUrl.slice("sqlite:".length) : databaseUrl;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzleSqlite(sqlite, { schema: sqliteSchema });
  return { db, raw: sqlite };
}

async function createPostgresClient() {
  const { Pool } = pg;
  const pool = new Pool({ connectionString: config.databaseUrl });

  const db = drizzlePg(pool, { schema: pgSchema });
  return { db, raw: pool };
}

const isPg = isPostgres(config.databaseUrl);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let rawSqlite: Database.Database | null = null;
let rawPg: pg.Pool | null = null;

if (isPg) {
  const client = await createPostgresClient();
  db = client.db;
  rawPg = client.raw;
} else {
  const client = createSqliteClient();
  db = client.db;
  rawSqlite = client.raw;
}

export { db, rawSqlite, rawPg, isPg };

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    if (rawSqlite) {
      rawSqlite.prepare("SELECT 1").get();
    } else if (rawPg) {
      await rawPg.query("SELECT 1");
    }
    return true;
  } catch {
    return false;
  }
}
