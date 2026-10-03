// Provisiona um TENANT novo (multi-tenant): cria a linha em `stores` (se
// ainda não existir), um `store_settings` próprio e um usuário gerente
// inicial com PIN aleatório impresso uma única vez no log.
//
// Diferente de seed-prod.ts (que provisionava a UNICA loja "default"),
// este cria uma loja isolada, acessível no subdomínio
// `<STORE_SLUG>.labolabe.tech`.
//
// Uso (dentro do container do backend, uma vez por tenant):
//   STORE_SLUG=ana-terra STORE_NAME="Ana Terra" \
//   MERCHANT_NAME="Ana Terra" MERCHANT_CITY="Porto Alegre" MANAGER_NAME="Roberto" \
//   node dist/infra/db/provision-tenant.js
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { runMigrations } from "./migrate.js";
import { closeDatabase, db } from "./client.js";
import { stores, storeSettings, users } from "./schema.js";

function randomPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

async function provisionTenant() {
  // migrations são async no Postgres: sem await o provisionamento competiria
  // com o DDL (e poderia tentar inserir em stores antes do CREATE TABLE).
  await runMigrations();

  const slug = process.env.STORE_SLUG?.trim();
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error("STORE_SLUG obrigatório: letras minúsculas, números e hífen (ex.: ana-terra)");
  }
  const storeName = process.env.STORE_NAME ?? slug;
  const merchantName = process.env.MERCHANT_NAME ?? storeName;
  const merchantCity = process.env.MERCHANT_CITY ?? "";
  const managerName = process.env.MANAGER_NAME ?? "Gerente";

  // Store: cria ou reutiliza (idempotente por slug).
  let store = await db.query.stores.findFirst({ where: eq(stores.slug, slug) });
  if (!store) {
    await db.insert(stores).values({
      id: randomUUID(),
      name: storeName,
      slug,
      status: "active",
    });
    store = await db.query.stores.findFirst({ where: eq(stores.slug, slug) });
    console.log(`[provision-tenant] store "${slug}" criada (${store!.id}).`);
  } else {
    console.log(`[provision-tenant] store "${slug}" já existe — reutilizando.`);
  }

  // store_settings: uma linha por tenant (id derivado do slug, nunca o
  // "singleton" da loja default).
  const settingsId = `${slug}-singleton`;
  const existingSettings = await db.query.storeSettings.findFirst({
    where: eq(storeSettings.storeId, store!.id),
  });
  if (existingSettings) {
    console.log(`[provision-tenant] store_settings já existe para "${slug}" — nada a fazer.`);
  } else {
    await db.insert(storeSettings).values({
      id: settingsId,
      storeId: store!.id,
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
    console.log(`[provision-tenant] store_settings criado para "${slug}".`);
  }

  const pin = randomPin();
  const pinHash = await argon2.hash(pin);
  await db.insert(users).values({ name: managerName, role: "manager", pinHash, storeId: store!.id });

  console.log(`[provision-tenant] concluído.`);
  console.log(`[provision-tenant] Usuário gerente "${managerName}" criado — PIN: ${pin}`);
  console.log(`[provision-tenant] ANOTE ESSE PIN AGORA — não será mostrado de novo. Troque-o na tela de Equipe assim que entrar.`);
  console.log(`[provision-tenant] Tenant acessível em: https://${slug}.labolabe.tech`);
}

provisionTenant()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDatabase();
    process.exit(1);
  });
