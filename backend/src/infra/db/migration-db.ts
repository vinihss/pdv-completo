// Pool de MIGRATION — o DONO do schema (DDL), nunca o papel do app.
//
// POR QUE UM POOL SEPARADO
// -----------------------
// O app vai passar a conectar com um papel **restrito** (sem superuser e sem
// BYPASSRLS) — é o pré-requisito do RLS: superuser sempre burla row security,
// mesmo com `FORCE ROW LEVEL SECURITY`, então policy sem papel restrito é
// fachada de isolamento.
//
// Mas quem aplica DDL (as migrations) precisa ser o DONO das tabelas: o papel
// do app não tem (e não deve ter) direito de `CREATE TABLE`/`ALTER`. Por isso
// as migrations falam com o pool de migração — o `MIGRATION_DATABASE_URL`, que
// aponta para o papel dono — enquanto o runtime fala com o `DATABASE_URL`, que
// aponta para o papel do app.
//
// Ausência de `MIGRATION_DATABASE_URL` → cai no `DATABASE_URL` (o comportamento
// de hoje, em que o app é o próprio dono). A troca de papel é opt-in por env.
//
// O pool é CURTO: a migration abre, aplica e fecha. Não é o pool do runtime
// (que é por schema de tenant, em `tenant-db.ts`).
import { Pool } from "pg";
import { config } from "../../config/env.js";
import { isSafeSchemaName } from "../../domain/tenant.js";

/**
 * Roda `fn` com um pool de migração apontado para o schema indicado.
 *
 * O `search_path` vai no startup packet (`options`), como no pool de runtime:
 * a migration de um schema de tenant tem que rodar DENTRO dele (o DDL é
 * aplicado no schema do tenant, não no `public`).
 */
export async function withMigrationPool<T>(
  schemaName: string,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  if (!isSafeSchemaName(schemaName)) {
    throw new Error(`[migration-db] schema_name inválido: ${JSON.stringify(schemaName)}`);
  }

  const pool = new Pool({
    connectionString: config.migrationDatabaseUrl,
    max: 2,
    connectionTimeoutMillis: 10_000,
    options: `-c search_path=${schemaName},public,pg_temp`,
  });

  // Mesmo motivo do pool de runtime: sem este listener, uma conexão ociosa
  // que morre derruba o PROCESSO (`pg` emite 'error' no pool).
  pool.on("error", (err) => {
    console.warn(`[migration-db] erro de conexão no pool de ${schemaName}:`, err?.message ?? String(err));
  });

  try {
    return await fn(pool);
  } finally {
    await pool.end().catch(() => {});
  }
}
