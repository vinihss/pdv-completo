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
import { runRegistryMigrations } from "./registry-migrate.js";
import { runMigrations } from "./migrate.js";
import { db } from "./client.js";
import { PostgresIdentityRepository } from "./repositories/identity.repository.ts";
import { newId } from "../../application/identity/identity-helpers.js";
import { users, categories, products, restaurantTables, storeSettings, kitchenGroups, stockMovements } from "./schema.js";

// Senha de DEV de todas as contas do seed (docs/26 §4). O PIN continua valendo
// para a rota fallback `/login/pin`; o login novo usa email + esta senha, com
// `must_change_password = false` para o fluxo de demonstração não parar na tela
// de troca obrigatória. NUNCA rode este seed em produção (`npm run seed:prod`
// não cria dados fictícios).
export const DEV_ACCOUNT_PASSWORD = "pdv1234";

// Usuários demo são reconciliados em TODA execução do seed (não só no primeiro
// populate): cada um é inserido apenas se ainda não existir pelo nome. Isso faz
// o `~/umami-utils/docker-up.sh` criar usuários de teste novos (ex.: Caixa, Entregador)
// mesmo quando o banco já foi seedado por uma versão antiga do seed — antes, a
// guarda de store_settings pulava o seed inteiro e os usuários novos nunca
// apareciam.
export const DEMO_USERS = [
  { name: "Ana Ribeiro", role: "waiter" as const, pin: "1234", phone: "11999990001", email: "ana.ribeiro@pdv.local" },
  { name: "Carlos Lima", role: "waiter" as const, pin: "5678", phone: "11999990002", email: "carlos.lima@pdv.local" },
  { name: "Roberto Alves", role: "manager" as const, pin: "9999", phone: "11999990003", email: "roberto.alves@pdv.local" },
  { name: "Caixa Teste", role: "cashier" as const, pin: "2468", phone: "11999990004", email: "caixa.teste@pdv.local" },
  { name: "Entregador Teste", role: "courier" as const, pin: "1357", phone: "11999990005", email: "entregador.teste@pdv.local" },
  { name: "Marcos Entrega", role: "courier" as const, pin: "2222", phone: "11999990007", email: "marcos.entrega@pdv.local" },
  { name: "Júlia Entrega", role: "courier" as const, pin: "3333", phone: "11999990008", email: "julia.entrega@pdv.local" },
  { name: "Estação Cozinha", role: "kitchen" as const, pin: "0000", phone: "11999990006", email: "cozinha@pdv.local" },
];

/**
 * Garante a conta GLOBAL do usuário demo (docs/26 §3): cria/reaproveita por
 * email, (re)define a senha de DEV com troca NÃO obrigatória e liga a linha
 * `user` à conta. Idempotente — é o que faz o login por email funcionar também
 * nos bancos já seedados antes desta onda (onde `account_id` nasceu NULL).
 */
async function ensureDevAccount(user: { id: string; name: string; email: string }, passwordHash: string) {
  return db.transaction(async (tx) => {
    const identity = new PostgresIdentityRepository(tx);
    const now = new Date().toISOString();
    const account = await identity.ensureAccount({ id: newId(), email: user.email, name: user.name, now });
    await identity.setAccountPassword(account.id, { passwordHash, mustChangePassword: false, now });
    await tx.update(users).set({ accountId: account.id }).where(eq(users.id, user.id));
    return account;
  });
}

function printDemoAccounts() {
  console.log(`[seed] contas de teste (login por email/senha — senha: ${DEV_ACCOUNT_PASSWORD})`);
  for (const u of DEMO_USERS) console.log(`[seed]   ${u.email}  (${u.name} · ${u.role})`);
}

async function reconcileDemoUsers() {
  const passwordHash = await argon2.hash(DEV_ACCOUNT_PASSWORD);
  for (const u of DEMO_USERS) {
    let found = await db.query.users.findFirst({ where: eq(users.name, u.name) });
    if (!found) {
      const pinHash = await argon2.hash(u.pin);
      const [created] = await db
        .insert(users)
        .values({ name: u.name, role: u.role, pinHash, phone: u.phone ?? null, email: u.email ?? null })
        .returning();
      found = created;
      console.log(`[seed] + usuário demo criado: ${u.name} (${u.role})`);
    }
    if (found) await ensureDevAccount({ id: found.id, name: found.name, email: u.email }, passwordHash);
  }
}

export async function runBaseSeed(): Promise<void> {
  // ORDEM DO BOOT (server.ts): o registry cria as tabelas GLOBAIS de identidade
  // (`public.account`) e vem ANTES das migrations de tenant — a
  // `0012_user_account_id.sql` cria a FK do `user` para `public.account`.
  await runRegistryMigrations();
  // migrations são async no Postgres: sem await o seed competiria com o DDL.
  await runMigrations();

  const existing = await db.query.storeSettings.findFirst({ where: eq(storeSettings.id, "singleton") });
  if (existing) {
    console.log("[seed] store_settings já existe — pulando dados base e reconciliando usuários demo.");
    await reconcileDemoUsers();
    console.log("[seed] concluído.");
    console.log("[seed] PINs de teste — Ana: 1234 · Carlos: 5678 · Roberto: 9999 · Caixa: 2468 · Entregador: 1357 · Marcos: 2222 · Júlia: 3333 · Cozinha: 0000");
    printDemoAccounts();
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
    inventoryEnabled: true, // demo com controle de estoque ligado
    enabledPaymentMethods: JSON.stringify(["cash", "card", "pix", "other"]),
    kitchenPrepWarnMin: 3,
    kitchenPrepUrgentMin: 6,
    kitchenPickupUrgentMin: 5,
  });

  const devPasswordHash = await argon2.hash(DEV_ACCOUNT_PASSWORD);
  let managerId: string = "";
  for (const u of DEMO_USERS) {
    const pinHash = await argon2.hash(u.pin);
    const [created] = await db.insert(users).values({ name: u.name, role: u.role, pinHash, phone: u.phone ?? null, email: u.email ?? null }).returning();
    if (u.role === "manager") managerId = created.id;
    await ensureDevAccount({ id: created.id, name: created.name, email: u.email }, devPasswordHash);
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
  console.log("[seed] PINs de teste — Ana: 1234 · Carlos: 5678 · Roberto: 9999 · Caixa: 2468 · Entregador: 1357 · Marcos: 2222 · Júlia: 3333 · Cozinha: 0000");
  printDemoAccounts();
}
