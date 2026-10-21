// Backfill das contas globais (docs/26 §3): liga cada usuário de loja que já tem
// email a uma conta de identidade centralizada.
//
// NÃO roda no boot — é um passo de cutover, rodado à mão UMA vez por instalação
// (`npm run db:backfill-accounts`), depois de as migrations estarem aplicadas.
// Motivo de não estar no boot: numa instalação grande o backfill faz argon2 e
// N inserts numa janela de boot com healthcheck; e numa instalação que ainda não
// migrou, criar contas "dormant" para todo mundo seria um efeito colateral
// silencioso. Quem decide o momento é a operação.
//
// O que ele faz, por schema de tenant (default + ativos do registry):
//   1. lê os `user` com email preenchido e `account_id IS NULL`;
//   2. cria/reaproveita a conta global pelo email (`ensureAccount`) — SEM senha:
//      a credencial nasce no convite (`POST /users`) ou no `esqueci a senha`;
//   3. liga a linha `user` à conta.
//
// Idempotente: na segunda execução não há `account_id IS NULL` e nada acontece.
// O login por PIN continua funcionando para quem não tem conta (o vínculo só
// ACRESCENTA o login por email).
import { eq } from "drizzle-orm";
import { db, pool, closeDatabase } from "./client.js";
import { runInTenantScope } from "./tenant-context.js";

import { listActiveTenants } from "../tenant/registry.js";
import { DEFAULT_TENANT_SLUG } from "../../application/tenant/resolve-tenant.usecase.js";
import { normalizeEmail, newId } from "../../application/identity/identity-helpers.js";
import { PostgresIdentityRepository } from "./repositories/identity.repository.ts";
import { users } from "./schema.js";
import { DEFAULT_TENANT_ID } from "../../domain/tenant.js";

interface Scope {
  /** Id do tenant (uuid) — o mesmo que o escopo ALS carrega. */
  tenantId: string;
  slug: string;
}

/** Default primeiro, depois os ativos do registry (dedup por slug). */
async function resolveScopes(): Promise<Scope[]> {
  const bySlug = new Map<string, Scope>();
  bySlug.set(DEFAULT_TENANT_SLUG, {
    tenantId: DEFAULT_TENANT_ID,
    slug: DEFAULT_TENANT_SLUG,
  });
  for (const tenant of await listActiveTenants()) {
    if (bySlug.has(tenant.slug)) continue;
    bySlug.set(tenant.slug, {
      tenantId: tenant.id,
      slug: tenant.slug,
    });
  }
  return [...bySlug.values()];
}

async function backfillScope(scope: Scope): Promise<{ linked: number; skipped: number }> {
  return runInTenantScope({ ...scope, isDefault: scope.slug === DEFAULT_TENANT_SLUG }, async () => {
    // O schema é o ÚNICO do app: se a tabela `user` não estiver lá, o seed
    // não rodou e não há o que ligar.
    const provisioned = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'user' LIMIT 1`,
    );
    if (provisioned.rows.length === 0) {
      console.log(`[backfill] ${scope.slug}: sem tabela user (seed não rodou) — pulando`);
      return { linked: 0, skipped: 0 };
    }

    const { rows } = await pool.query<{ id: string; name: string; email: string | null }>(
      `SELECT id, name, email FROM "user" WHERE account_id IS NULL AND email IS NOT NULL AND trim(email) <> '' ORDER BY name`,
    );

    let linked = 0;
    let skipped = 0;
    for (const row of rows) {
      const email = normalizeEmail(row.email);
      if (!email) {
        skipped += 1;
        continue;
      }
      await db.transaction(async (tx) => {
        const identity = new PostgresIdentityRepository(tx);
        const now = new Date().toISOString();
        const account = await identity.ensureAccount({ id: newId(), email, name: row.name, now });
        await tx.update(users).set({ accountId: account.id }).where(eq(users.id, row.id));
      });
      linked += 1;
    }
    console.log(`[backfill] ${scope.slug}: ${linked} usuário(s) vinculado(s), ${skipped} ignorado(s)`);
    return { linked, skipped };
  });
}

async function main() {
  const scopes = await resolveScopes();
  console.log(`[backfill] schemas: ${scopes.map((s) => s.slug).join(", ")}`);
  let total = 0;
  for (const scope of scopes) {
    const result = await backfillScope(scope);
    total += result.linked;
  }
  console.log(`[backfill] concluído — ${total} vínculo(s) criado(s).`);
}

main()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[backfill] falhou:", err);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
