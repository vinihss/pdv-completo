// Adiciona um usuário a um tenant existente.
//
// Uso (dentro do container do backend):
//   SLUG=umami USER_NAME="João" USER_PROFILE=waiter [USER_PIN=1234] node dist/infra/db/add-user.js
// No repo o caminho curto é a TUI (`pdv tui` → detalhes do tenant → `u`) ou:
//   cd backend && npx tsx src/infra/db/add-user.ts <slug> "<nome>" <perfil> [pin]
//
// O comando:
//  1. Valida slug, nome, perfil (waiter/kitchen/manager/cashier/courier) e
//     (quando informado) o PIN (4–6 dígitos).
//  2. Busca o tenant no registry (`public.tenant`) — falha se não existir.
//  3. Entra no escopo ALS do tenant (`runInTenantScope`) para que o `db` Proxy
//     roteie as queries para o schema correto (`tenant_<slug>`).
//  4. Hasheia o PIN com argon2 (mesmo algoritmo do seed e do reset de PIN) e
//     insere a linha em `user`.
//  5. Imprime o PIN em texto claro no console (anotar antes que suma).
//
// Se o PIN não for informado, gera um aleatório de 4 dígitos.
import { closeDatabase, db } from "./client.js";
import { users } from "./schema.js";
import argon2 from "argon2";
import { runInTenantScope } from "./tenant-context.js";
import { findTenantBySlug } from "../tenant/registry.js";

const PROFILES = ["waiter", "kitchen", "manager", "cashier", "courier"] as const;
type Profile = (typeof PROFILES)[number];

function randomPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export async function addUser(
  slug: string,
  name: string,
  profile: string,
  pin?: string,
): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`slug inválido: ${slug} (use letras minúsculas, números e hífen)`);
  }
  const userName = name.trim();
  if (!userName) {
    throw new Error("nome do usuário é obrigatório");
  }
  if (!(PROFILES as readonly string[]).includes(profile)) {
    throw new Error(
      `perfil inválido: ${profile} (use: ${PROFILES.join(", ")})`,
    );
  }
  if (pin !== undefined && !/^\d{4,6}$/.test(pin)) {
    throw new Error(`PIN inválido: ${pin} (use 4–6 dígitos)`);
  }

  const tenant = await findTenantBySlug(slug);
  if (!tenant) {
    throw new Error(`tenant "${slug}" não encontrado no registry (public.tenant)`);
  }

  const newPin = pin ?? randomPin();
  const pinHash = await argon2.hash(newPin);

  await runInTenantScope({ schemaName: tenant.schemaName, slug, isDefault: false }, async () => {
    await db.insert(users).values({
      name: userName,
      role: profile as Profile,
      pinHash,
    });
    console.log(`[add-user] usuário "${userName}" (${profile}) criado no tenant "${slug}"`);
    if (profile === "manager") {
      // `reset-manager-pin.ts` exige EXATAMENTE 1 usuário com role=manager.
      console.warn(
        "[add-user] aviso: agora há mais de um manager — `pdv db reset-pin`/TUI falharão até restar um só",
      );
    }
  });

  return newPin;
}

// CLI — mesmo padrão de `provision-tenant.ts`/`reset-manager-pin.ts`: env vars
// OU args posicionais. A TUI passa PIN="" quando não informado; `.trim() ||`
// garante que string vazia vire `undefined` (gerar aleatório).
if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = (process.env.SLUG ?? "").trim() || process.argv[2];
  const name = (process.env.USER_NAME ?? "").trim() || process.argv[3];
  const profile = (process.env.USER_PROFILE ?? "").trim() || process.argv[4];
  const pin = (process.env.USER_PIN ?? "").trim() || process.argv[5];

  if (!slug || !name || !profile) {
    console.error(
      'uso: SLUG=<tenant> USER_NAME="<nome>" USER_PROFILE=<perfil> [USER_PIN=<pin>] tsx src/infra/db/add-user.ts',
    );
    console.error('ou:  ./pdv tui  → detalhes do tenant → "u"');
    process.exit(1);
  }

  addUser(slug, name, profile, pin || undefined)
    .then(async (newPin) => {
      console.log(`\n[add-user] ✅ Usuário criado. PIN: ${newPin}`);
      console.log("[add-user] ⚠️  ANOTE ESTE PIN — não será mostrado novamente");
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`\n[add-user] ❌ Erro: ${(err as Error).message}\n`);
      await closeDatabase();
      process.exit(1);
    });
}
