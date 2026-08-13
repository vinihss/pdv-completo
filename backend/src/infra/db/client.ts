import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema.js";
import { config } from "../../config/env.js";

// Aceita "sqlite:./data/data.db" (formato da spec) ou um path puro.
function resolveSqlitePath(databaseUrl: string): string {
  return databaseUrl.startsWith("sqlite:") ? databaseUrl.slice("sqlite:".length) : databaseUrl;
}

const filePath = resolveSqlitePath(config.databaseUrl);
fs.mkdirSync(path.dirname(filePath), { recursive: true });

const sqlite = new Database(filePath);
// WAL mode: sobrevive a desligamento abrupto sem corromper o arquivo (§15 requisitos não-funcionais)
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export const rawSqlite = sqlite;
