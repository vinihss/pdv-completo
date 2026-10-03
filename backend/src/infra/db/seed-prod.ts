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
// Idempotente: rodar de novo não duplica nada nem sobrescreve o que o
// gerente já editou (ver `aplicaDadosEnv` abaixo).
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { runMigrations } from "./migrate.js";
import { closeDatabase, db } from "./client.js";
import { users, storeSettings } from "./schema.js";
import { DEFAULT_STORE_ID } from "../../domain/constants.js";

function randomPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/**
 * Garante 1 linha de settings por store existente (idempotente).
 *
 * A migration 0011 já cria a linha de toda store sem settings — aqui é a rede
 * de segurança + o lugar onde os dados de ENV entram. Retorna `true` quando a
 * store default ainda está no placeholder criado pela migration (nome igual ao
 * da store + cidade vazia = ninguém editou), único caso em que os valores de
 * ENV podem ser aplicados sem apagar o que o gerente já cadastrou.
 */
async function ensureStoreSettings(): Promise<boolean> {
  const allStores = await db.query.stores.findMany();
  let defaultUntouched = false;

  for (const store of allStores) {
    const existing = await db.query.storeSettings.findFirst({ where: eq(storeSettings.storeId, store.id) });

    if (!existing) {
      const isDefault = store.id === DEFAULT_STORE_ID;
      await db.insert(storeSettings).values({
        // Store default mantém o id histórico 'singleton' (dado legado);
        // demais stores nascem com id = store_id.
        id: isDefault ? "singleton" : store.id,
        storeId: store.id,
        merchantName: store.name,
        merchantCity: "",
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
      console.log(`[seed-prod] + store_settings criada para a store "${store.slug}"`);
      if (isDefault) defaultUntouched = true;
    } else if (store.id === DEFAULT_STORE_ID && existing.merchantName === store.name && existing.merchantCity === "") {
      defaultUntouched = true;
    }
  }

  return defaultUntouched;
}

async function seedProd() {
  // migrations são async no Postgres: sem await o seed competiria com o DDL.
  await runMigrations();

  // 1) Settings por store — toda store nasce com a sua linha.
  const defaultUntouched = await ensureStoreSettings();

  const merchantName = process.env.MERCHANT_NAME ?? "Meu Estabelecimento";
  const merchantCity = process.env.MERCHANT_CITY ?? "";

  // 2) Dados reais do estabelecimento (ENV) SÓ onde a linha ainda está no
  //    placeholder da migration. Quem já editou pela tela não é tocado — este
  //    script pode ser reexecutado sem medo.
  if (defaultUntouched) {
    await db
      .update(storeSettings)
      .set({ merchantName, merchantCity })
      .where(eq(storeSettings.storeId, DEFAULT_STORE_ID));
    console.log("[seed-prod] store_settings da store default preenchida com os dados de ENV.");
  } else {
    console.log("[seed-prod] store_settings da store default já tem dados — nada a sobrescrever.");
  }

  // 3) Gerente inicial: só se ainda não houver NENHUM gerente cadastrado.
  const managerName = process.env.MANAGER_NAME ?? "Gerente";
  const existingManager = await db.query.users.findFirst({ where: eq(users.role, "manager") });
  if (existingManager) {
    console.log(`[seed-prod] já existe um gerente ("${existingManager.name}") — nenhum usuário criado.`);
    console.log("[seed-prod] concluído.");
    return;
  }

  const pin = randomPin();
  const pinHash = await argon2.hash(pin);
  await db.insert(users).values({ name: managerName, role: "manager", pinHash });

  console.log("[seed-prod] concluído.");
  console.log(`[seed-prod] Usuário gerente "${managerName}" criado — PIN: ${pin}`);
  console.log("[seed-prod] ANOTE ESSE PIN AGORA — não será mostrado de novo. Troque-o na tela de Equipe assim que entrar.");
}

seedProd()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDatabase();
    process.exit(1);
  });
