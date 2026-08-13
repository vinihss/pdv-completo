// Runner de migrations simples: aplica cada .sql em /migrations, em ordem,
// registrando o que já rodou numa tabela de controle — idempotente, seguro
// pra rodar no boot do container em modo local (§14.5).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rawSqlite } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../../migrations");

export function runMigrations() {
  rawSqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (current_timestamp)
    );
  `);

  const applied = new Set(
    rawSqlite.prepare("SELECT name FROM _migrations").all().map((r: any) => r.name)
  );

  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    : [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const applyAll = rawSqlite.transaction(() => {
      rawSqlite.exec(sql);
      rawSqlite.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
    });
    applyAll();
    console.log(`[migrate] applied ${file}`);
  }
}

// Permite rodar via `npm run db:migrate` diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
  console.log("[migrate] done");
}
