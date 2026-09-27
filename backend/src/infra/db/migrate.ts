// Runner de migrations simples: aplica cada .sql em /migrations, em ordem,
// registrando o que já rodou numa tabela de controle — idempotente, seguro
// pra rodar no boot do container em modo local (§14.5).
// Suporta SQLite (modo local) e Postgres (modo cloud).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPg, rawSqlite, rawPg } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, isPg ? "../../../migrations-pg" : "../../../migrations");

export async function runMigrations(): Promise<void> {
  if (isPg) {
    await runPostgresMigrations();
  } else {
    runSqliteMigrations();
  }
}

function runSqliteMigrations(): void {
  rawSqlite!.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (current_timestamp)
    );
  `);

  const applied = new Set(
    rawSqlite!.prepare("SELECT name FROM _migrations").all().map((r: any) => r.name)
  );

  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    : [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    rawSqlite!.pragma("foreign_keys = OFF");
    try {
      const applyAll = rawSqlite!.transaction(() => {
        rawSqlite!.exec(sql);
        rawSqlite!.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
      });
      applyAll();
    } finally {
      rawSqlite!.pragma("foreign_keys = ON");
    }
    console.log(`[migrate] applied ${file}`);
  }
}

async function runPostgresMigrations(): Promise<void> {
  const pool = rawPg!;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query("SELECT name FROM _migrations");
  const applied = new Set(rows.map((r: any) => r.name));

  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    : [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

// Permite rodar via `npm run db:migrate` diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => console.log("[migrate] done"))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
