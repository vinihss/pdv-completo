// Seed de desenvolvimento — popula store_settings, usuários, categorias,
// produtos e mesas. Idempotente: pode rodar de novo sem duplicar (checa
// se store_settings já existe). Em primeiro deploy real, só a criação do
// usuário gerente inicial + store_settings mínimo é necessária — ver nota
// no final do arquivo (§14.3).
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { runMigrations } from "./migrate.js";
import { db } from "./client.js";
import { users, categories, products, restaurantTables, storeSettings, kitchenGroups } from "./schema.js";

async function seed() {
  runMigrations();

  const existing = await db.query.storeSettings.findFirst({ where: eq(storeSettings.id, "singleton") });
  if (existing) {
    console.log("[seed] já populado, pulando (delete data/data.db pra recomeçar do zero).");
    return;
  }

  await db.insert(storeSettings).values({
    id: "singleton",
    merchantName: "Bar do Zé",
    merchantCity: "Sao Paulo",
    pixKey: "",
    pixKeyType: "phone",
    usesTables: true,
    kitchenEnabled: true,
    usesDelivery: true,
    ifoodIntegrationEnabled: false,
    enabledPaymentMethods: JSON.stringify(["cash", "card", "pix", "other"]),
    kitchenPrepWarnMin: 3,
    kitchenPrepUrgentMin: 6,
    kitchenPickupUrgentMin: 5,
  });

  const seedUsers = [
    { name: "Ana Ribeiro", role: "waiter" as const, pin: "1234" },
    { name: "Carlos Lima", role: "waiter" as const, pin: "5678" },
    { name: "Roberto Alves", role: "manager" as const, pin: "9999" },
    { name: "Caixa Teste", role: "cashier" as const, pin: "2468" },
    { name: "Estação Cozinha", role: "kitchen" as const, pin: "0000" },
  ];
  for (const u of seedUsers) {
    const pinHash = await argon2.hash(u.pin);
    await db.insert(users).values({ name: u.name, role: u.role, pinHash });
  }

  const [bebidas] = await db.insert(categories).values({ name: "Bebidas", displayOrder: 1 }).returning();
  const [pratos] = await db.insert(categories).values({ name: "Pratos", displayOrder: 2 }).returning();
  const [porcoes] = await db.insert(categories).values({ name: "Porções", displayOrder: 3 }).returning();

  const [cozinha] = await db.insert(kitchenGroups).values({ name: "Cozinha", displayOrder: 1 }).returning();
  const [grelha] = await db.insert(kitchenGroups).values({ name: "Grelha", displayOrder: 2 }).returning();
  const [bar] = await db.insert(kitchenGroups).values({ name: "Bar", displayOrder: 3 }).returning();

  await db.insert(products).values([
    { categoryId: bebidas.id, kitchenGroupId: bar.id, name: "Chopp 300ml", price: 9.5 },
    {
      categoryId: bebidas.id,
      kitchenGroupId: bar.id,
      name: "Caipirinha",
      price: 18,
      variations: JSON.stringify([{ name: "Fruta", options: ["Limão", "Morango", "Maracujá"] }]),
    },
    {
      categoryId: pratos.id,
      kitchenGroupId: grelha.id,
      name: "X-Burger",
      price: 28,
      variations: JSON.stringify([
        { name: "Ponto da carne", options: ["Mal passado", "Ao ponto", "Bem passado"], required: true },
      ]),
    },
    { categoryId: pratos.id, kitchenGroupId: grelha.id, name: "Filé à parmegiana", price: 42 },
    { categoryId: porcoes.id, kitchenGroupId: cozinha.id, name: "Batata frita", price: 22 },
    { categoryId: porcoes.id, kitchenGroupId: cozinha.id, name: "Isca de peixe", price: 34 },
  ]);

  await db.insert(restaurantTables).values(
    Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1) }))
  );

  console.log("[seed] concluído.");
  console.log("[seed] PINs de teste — Ana: 1234 · Carlos: 5678 · Roberto: 9999 · Caixa: 2468 · Cozinha: 0000");
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

// Nota (§14.3): em produção real (primeiro deploy do estabelecimento), este
// script NÃO deve rodar como está — ele cria dados fictícios de demonstração.
// O fluxo real é: rodar só a criação de store_settings (com dados reais do
// estabelecimento) + um usuário "manager" inicial com PIN temporário, e
// deixar o gerente cadastrar o resto (categorias, produtos, garçons) pela
// tela de Configurações. Esse script serve para ambiente de desenvolvimento
// e para os dados de demonstração deste protótipo.
