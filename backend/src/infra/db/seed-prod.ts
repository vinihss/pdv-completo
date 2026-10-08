// Seed de PRIMEIRO DEPLOY REAL — diferente de seed.ts (que é só pra
// desenvolvimento e cria dados fictícios de demonstração). Este aqui cria
// só o mínimo pra o gerente conseguir entrar e cadastrar o resto pela
// própria tela de Configurações: store_settings com os dados reais do
// estabelecimento (via variáveis de ambiente) + um usuário manager inicial
// com PIN aleatório impresso uma única vez no log.
//
// Uso (dentro do container, uma única vez, no primeiro deploy):
//   MERCHANT_NAME="Bar do Zé" MERCHANT_CITY="Sao Paulo" MANAGER_NAME="Roberto" \
//   node dist/infra/db/seed-prod.js
//
// Também é o BOOTSTRAP do provisionamento de loja nova
// (`./pdv db provision <slug> "<nome>"` → `provision-tenant.ts`), que o chama
// dentro do escopo ALS do schema recém-criado: como `db`/`pool` são Proxies
// que resolvem o schema pelo ALS (`client.ts`), o MESMO código grava em
// `tenant_<slug>` sem mudar uma linha. Rodar de novo é seguro: o guard de
// `store_settings` faz nothing-to-do.
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { runMigrations } from "./migrate.js";
import { closeDatabase, db } from "./client.js";
import { users, storeSettings } from "./schema.js";

function randomPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export type ProdSeedOptions = {
  /** Nome do estabelecimento; cai no `MERCHANT_NAME` do ambiente, depois no default. */
  merchantName?: string;
  /** Nome do primeiro manager; cai no `MANAGER_NAME` do ambiente, depois no default. */
  managerName?: string;
};

export async function runProdSeed(opts: ProdSeedOptions = {}): Promise<void> {
  // migrations são async no Postgres: sem await o seed competiria com o DDL.
  await runMigrations();

  const existing = await db.query.storeSettings.findFirst({ where: eq(storeSettings.id, "singleton") });
  if (existing) {
    console.log("[seed-prod] store_settings já existe — nada a fazer. Use a tela de Configurações pra editar.");
    return;
  }

  const merchantName = opts.merchantName ?? process.env.MERCHANT_NAME ?? "Meu Estabelecimento";
  const merchantCity = process.env.MERCHANT_CITY ?? "";
  const managerName = opts.managerName ?? process.env.MANAGER_NAME ?? "Gerente";

  await db.insert(storeSettings).values({
    id: "singleton",
    merchantName,
    merchantCity,
    pixKey: "",
    pixKeyType: "phone",
    usesTables: true,
    kitchenEnabled: true,
    usesDelivery: true,
    ifoodIntegrationEnabled: false,
    whatsappIntegrationEnabled: false,
    enabledPaymentMethods: JSON.stringify(["cash", "card", "pix", "other"]),
    kitchenPrepWarnMin: 3,
    kitchenPrepUrgentMin: 6,
    kitchenPickupUrgentMin: 5,
  });

  const pin = randomPin();
  const pinHash = await argon2.hash(pin);
  await db.insert(users).values({ name: managerName, role: "manager", pinHash });

  console.log("[seed-prod] concluído.");
  console.log(`[seed-prod] Usuário gerente "${managerName}" criado — PIN: ${pin}`);
  console.log("[seed-prod] ANOTE ESSE PIN AGORA — não será mostrado de novo. Troque-o na tela de Equipe assim que entrar.");
}

// CLI próprio. Precisa do guard: `provision-tenant.ts` importa este arquivo
// para reutilizar o bootstrap, e sem o guard o import dispararia um seed no
// schema default (public) no meio do provisionamento.
if (import.meta.url === `file://${process.argv[1]}`) {
  runProdSeed()
    .then(async () => {
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err);
      await closeDatabase();
      process.exit(1);
    });
}
