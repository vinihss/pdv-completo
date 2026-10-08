
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registryDir = path.resolve(__dirname, "../../../migrations/registry");

// Chave DIFERENTE da do runner de tenant (`migrate.ts` usa 8_675_309): os dois
// podem rodar no mesmo boot (o registry ANTES, §6.1) e são operações distintas
// — serializar as duas no mesmo lock só tornaria o boot mais lento sem
// impedir corrida alguma.
const REGISTRY_LOCK_KEY = 8_675_310;

export async function runRegistryMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [REGISTRY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS public._registry_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    `);

    const { rows } = await client.query<{ name: string }>("SELECT name FROM public._registry_migrations");
    const applied = new Set(rows.map((r) => r.name));

    const files = fs.existsSync(registryDir)
      ? fs.readdirSync(registryDir)
          .filter((f) => f.endsWith(".sql"))
          .sort()
      : [];

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(registryDir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL search_path = public");
        await client.query(sql);
        await client.query("INSERT INTO public._registry_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(
          `[registry-migrate] falhou ao aplicar ${file}: ${(err as Error).message}`,
          { cause: err },
        );
      }
      console.log(`[registry-migrate] applied ${file}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [REGISTRY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// Permite rodar via `npm run db:migrate:registry` diretamente.
if (import.meta.url === `file://${process.argv[1]}`) {
  runRegistryMigrations()
    .then(() => console.log("[registry-migrate] done"))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
