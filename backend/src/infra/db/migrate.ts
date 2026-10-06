// Runner de migrations: aplica cada .sql de backend/migrations em ordem,
// registrando o que já rodou na tabela de controle `_migrations` — idempotente,
// seguro pra rodar no boot do container.
//
// Postgres é o único banco suportado, então não há mais o caso especial do
// SQLite (PRAGMA foreign_keys, reativação fora da transação): aqui cada
// migration roda numa transação real com um advisory lock, para que dois
// containers subindo ao mesmo tempo (ou o boot racing com o `db:migrate`)
// não tentem aplicar o mesmo arquivo.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../../migrations");

// Chave fixa do advisory lock: serializa migrations entre processos.
// picked arbitrariamente; só precisa ser exclusivo entre os runners do PDV.
const LOCK_KEY = 8_675_309;

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    `);

    const { rows } = await client.query<{ name: string }>("SELECT name FROM _migrations");
    const applied = new Set(rows.map((r) => r.name));

    const files = fs.existsSync(migrationsDir)
      ? fs.readdirSync(migrationsDir)
          // Só arquivo `.sql` no PRÓPRIO diretório. A pasta `registry/` mora
          // dentro de `migrations/` de propósito e precisa ficar de fora: ela é
          // o índice dos schemas de tenant (`public.tenant`), e se este runner
          // a lesse, a Fase 3 a aplicaria dentro de CADA schema de loja. O
          // filtro `endsWith(".sql")` já a exclui (diretório não termina em
          // `.sql`); o `statSync` é a segunda barreira, para o dia em que
          // alguém criar um diretório que termine em `.sql`.
          .filter((f) => f.endsWith(".sql") && fs.statSync(path.join(migrationsDir, f)).isFile())
          .sort()
      : [];

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`[migrate] falhou ao aplicar ${file}: ${(err as Error).message}`, { cause: err });
      }
      console.log(`[migrate] applied ${file}`);
    }
  } finally {
    // Solta o lock e devolve a conexão ao pool mesmo em caso de erro.
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
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
