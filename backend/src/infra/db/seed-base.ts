// Seed BASE — popula store_settings, usuários, categorias, produtos e mesas.
// Este é o corpo do clássico `npm run seed`; o arquivo `seed.ts` virou só o
// runner executável (process.exit + closeDatabase) para que outros scripts
// possam reutilizar o base importando `runBaseSeed()` — é o que o
// `npm run seed:demo` (seed-demo.ts) faz antes de popular o histórico.
//
// Os dados base são idempotentes (checam store_settings pra não duplicar); os
// usuários demo são reconciliados em toda execução (só os que faltam são
// criados). Em primeiro deploy real, só a criação do usuário gerente inicial +
// store_settings mínimo é necessária — ver nota no final de seed.ts (§14.3).
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { runMigrations } from "./migrate.js";
import { db } from "./client.js";
import { users, categories, products, restaurantTables, storeSettings, kitchenGroups, stockMovements } from "./schema.js";

// Usuários demo são reconciliados em TODA execução do seed (não só no primeiro
// populate): cada um é inserido apenas se ainda não existir pelo nome. Isso faz
// o `~/umami-utils/docker-up.sh` criar usuários de teste novos (ex.: Caixa, Entregador)
// mesmo quando o banco já foi seedado por uma versão antiga do seed — antes, a
// guarda de store_settings pulava o seed inteiro e os usuários novos nunca
// apareciam.
export const DEMO_USERS = [
  { name: "Ana Ribeiro", role: "waiter" as const, pin: "1234", phone: "11999990001", email: "ana.ribeiro@exemplo.com" },
  { name: "Carlos Lima", role: "waiter" as const, pin: "5678", phone: "11999990002", email: "carlos.lima@exemplo.com" },
  { name: "Roberto Alves", role: "manager" as const, pin: "9999", phone: "11999990003", email: "roberto.alves@exemplo.com" },
  { name: "Caixa Teste", role: "cashier" as const, pin: "2468", phone: "11999990004", email: "caixa.teste@exemplo.com" },
  { name: "Entregador Teste", role: "courier" as const, pin: "1357", phone: "11999990005", email: "entregador.teste@exemplo.com" },
  { name: "Estação Cozinha", role: "kitchen" as const, pin: "0000", phone: "11999990006", email: "cozinha@exemplo.com" },
];

async function reconcileDemoUsers() {
  for (const u of DEMO_USERS) {
    const found = await db.query.users.findFirst({ where: eq(users.name, u.name) });
    if (found) continue;
    const pinHash = await argon2.hash(u.pin);
    await db.insert(users).values({ name: u.name, role: u.role, pinHash, phone: u.phone ?? null, email: u.email ?? null });
    console.log(`[seed] + usuário demo criado: ${u.name} (${u.role})`);
  }
}

export async function runBaseSeed(): Promise<void> {
  // migrations são async no Postgres: sem await o seed competiria com o DDL.
  await runMigrations();

  const existing = await db.query.storeSettings.findFirst({ where: eq(storeSettings.id, "singleton") });
  if (existing) {
    console.log("[seed] store_settings já existe — pulando dados base e reconciliando usuários demo.");
    await reconcileDemoUsers();
    console.log("[seed] concluído.");
    console.log("[seed] PINs de teste — Ana: 1234 · Carlos: 5678 · Roberto: 9999 · Caixa: 2468 · Entregador: 1357 · Cozinha: 0000");
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
    whatsappIntegrationEnabled: false,
    inventoryEnabled: true, // demo com controle de estoque ligado
    enabledPaymentMethods: JSON.stringify(["cash", "card", "pix", "other"]),
    kitchenPrepWarnMin: 3,
    kitchenPrepUrgentMin: 6,
    kitchenPickupUrgentMin: 5,
  });

  let managerId: string = "";
  for (const u of DEMO_USERS) {
    const pinHash = await argon2.hash(u.pin);
    const [created] = await db.insert(users).values({ name: u.name, role: u.role, pinHash, phone: u.phone ?? null, email: u.email ?? null }).returning();
    if (u.role === "manager") managerId = created.id;
  }

  const [bebidas] = await db.insert(categories).values({ name: "Bebidas", displayOrder: 1 }).returning();
  const [pratos] = await db.insert(categories).values({ name: "Pratos", displayOrder: 2 }).returning();
  const [porcoes] = await db.insert(categories).values({ name: "Porções", displayOrder: 3 }).returning();

  const [cozinha] = await db.insert(kitchenGroups).values({ name: "Cozinha", displayOrder: 1 }).returning();
  const [grelha] = await db.insert(kitchenGroups).values({ name: "Grelha", displayOrder: 2 }).returning();
  const [bar] = await db.insert(kitchenGroups).values({ name: "Bar", displayOrder: 3 }).returning();

  // Demo de estoque: alguns produtos com custo e rastreamento; o saldo é
  // criado como movimento 'adjustment' (Estoque inicial) no ledger.
  const seededProducts = await db.insert(products).values([
    { categoryId: bebidas.id, kitchenGroupId: bar.id, name: "Chopp 300ml", price: 9.5, costPrice: 3, trackStock: true, lowStockThreshold: 20 },
    {
      categoryId: bebidas.id,
      kitchenGroupId: bar.id,
      name: "Caipirinha",
      price: 18,
      costPrice: 6,
      variations: JSON.stringify([{ name: "Fruta", options: ["Limão", "Morango", "Maracujá"] }]),
    },
    {
      categoryId: pratos.id,
      kitchenGroupId: grelha.id,
      name: "X-Burger",
      price: 28,
      costPrice: 11,
      trackStock: true,
      lowStockThreshold: 10,
      variations: JSON.stringify([
        { name: "Ponto da carne", options: ["Mal passado", "Ao ponto", "Bem passado"], required: true },
      ]),
    },
    { categoryId: pratos.id, kitchenGroupId: grelha.id, name: "Filé à parmegiana", price: 42, costPrice: 18, trackStock: true, lowStockThreshold: 8 },
    { categoryId: porcoes.id, kitchenGroupId: cozinha.id, name: "Batata frita", price: 22, costPrice: 7, trackStock: true, lowStockThreshold: 15 },
    { categoryId: porcoes.id, kitchenGroupId: cozinha.id, name: "Isca de peixe", price: 34, costPrice: 15, trackStock: true, lowStockThreshold: 10 },
  ]).returning();

  // Saldo inicial = movimento de ajuste por produto rastreado. Estoque baixo
  // deixado em um deles (Batata frita) pra aba Estoque já nascer com alerta.
  const initialByProduct: Record<string, number> = {
    "Chopp 300ml": 60,
    "X-Burger": 40,
    "Filé à parmegiana": 25,
    "Batata frita": 12, // abaixo do threshold → stock.low
    "Isca de peixe": 20,
  };
  const stockRows = seededProducts
    .filter((p) => p.trackStock && initialByProduct[p.name] !== undefined)
    .map((p) => ({
      productId: p.id,
      type: "adjustment" as const,
      quantityDelta: initialByProduct[p.name],
      note: "Estoque inicial",
      createdBy: managerId,
    }));
  if (stockRows.length > 0) await db.insert(stockMovements).values(stockRows);

  await db.insert(restaurantTables).values(
    Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1) }))
  );

  console.log("[seed] concluído.");
  console.log("[seed] PINs de teste — Ana: 1234 · Carlos: 5678 · Roberto: 9999 · Caixa: 2468 · Entregador: 1357 · Cozinha: 0000");
}
