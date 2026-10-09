// Reseta o PIN do gerente de um tenant existente.
//
// Uso (dentro do container do backend):
//   SLUG=umami [PIN=1234] node dist/infra/db/reset-manager-pin.js
// No repo o caminho curto é `./pdv db reset-pin umami [1234]`.
//
// O comando:
//  1. Valida o slug e (quando informado) o PIN (4–6 dígitos).
//  2. Busca o tenant no registry (`public.tenant`) — falha se não existir.
//  3. Entra no escopo ALS do tenant (`runInTenantScope`) para que o `db`
//     Proxy roteie as queries para o schema correto (`tenant_<slug>`).
//  4. Busca exatamente 1 usuário com `role = 'manager'` — 0 ou 2+ é erro.
//  5. Hasheia o novo PIN com argon2 e grava o `pin_hash`.
//  6. Imprime o PIN em texto claro no console (anotar antes que suma).
//
// Se o PIN não for informado, gera um aleatório de 4 dígitos.
import { pool, closeDatabase, db } from "./client.js";
import { users } from "./schema.js";
import { eq } from "drizzle-orm";
import argon2 from "argon2";
import { runInTenantScope } from "./tenant-context.js";
import { findTenantBySlug } from "../tenant/registry.js";

function randomPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export async function resetManagerPin(slug: string, pin?: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`slug inválido: ${slug} (use letras minúsculas, números e hífen)`);
  }

  if (pin !== undefined && !/^\d{4,6}$/.test(pin)) {
    throw new Error(`PIN inválido: ${pin} (use 4–6 dígitos)`);
  }

  // Lookup no registry — roda FORA do escopo do tenant (o registry vive em public).
  const tenant = await findTenantBySlug(slug);
  if (!tenant) {
    throw new Error(`tenant "${slug}" não encontrado no registry (public.tenant)`);
  }

  const schemaName = tenant.schemaName;
  const newPin = pin ?? randomPin();
  const pinHash = await argon2.hash(newPin);

  // Entra no ALS do tenant para que o `db` Proxy roteie para `tenant_<slug>`.
  await runInTenantScope({ schemaName, slug, isDefault: false }, async () => {
    const managers = await db.query.users.findMany({
      where: eq(users.role, "manager"),
    });

    if (managers.length === 0) {
      throw new Error(`nenhum usuário manager encontrado no tenant "${slug}"`);
    }
    if (managers.length > 1) {
      throw new Error(
        `múltiplos managers encontrados no tenant "${slug}" (${managers.length}) — reset manual necessário`,
      );
    }

    const manager = managers[0];

    await db.update(users).set({ pinHash }).where(eq(users.id, manager.id));

    console.log(`[reset-pin] PIN do gerente "${manager.name}" atualizado com sucesso`);
  });

  return newPin;
}

// CLI — mesmo padrão do `provision-tenant.ts`: env vars OU args posicionais.
// O dispatcher (Go, `cmd/pdv`) passa PIN="" quando o usuário não informou;
// `.trim() ||` garante que string vazia vire `undefined` (gerar aleatório).
if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = (process.env.SLUG ?? "").trim() || process.argv[2];
  const pin = (process.env.PIN ?? "").trim() || process.argv[3];

  if (!slug) {
    console.error("uso: SLUG=<tenant> [PIN=<pin>] tsx src/infra/db/reset-manager-pin.ts");
    console.error("ou:  ./pdv db reset-pin <slug> [pin]");
    process.exit(1);
  }

  resetManagerPin(slug, pin || undefined)
    .then(async (newPin) => {
      console.log(`\n[reset-pin] ✅ Novo PIN: ${newPin}`);
      console.log("[reset-pin] ⚠️  ANOTE ESTE PIN — não será mostrado novamente");
      console.log("[reset-pin] 💡 Dica: troque-o na tela de Equipe assim que entrar\n");
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`\n[reset-pin] ❌ Erro: ${(err as Error).message}\n`);
      await closeDatabase();
      process.exit(1);
    });
}
