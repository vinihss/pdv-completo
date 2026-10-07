import jwt from "jsonwebtoken";
import type { FastifyInstance } from "fastify";
import { eq, or } from "drizzle-orm";
import { db, pool } from "../src/infra/db/client.js";
import { runMigrations } from "../src/infra/db/migrate.js";
import { buildApp } from "../src/http/server.js";
import { config } from "../src/config/env.js";
import argon2 from "argon2";
import { resetRateLimit } from "../src/http/middlewares/rate-limit.middleware.js";
import { resetCache } from "../src/infra/cache/index.js";
import { clearActiveUserCache } from "../src/infra/auth/active-user-check.js";
import {
  categories,
  kitchenGroups,
  products,
  restaurantTables,
  storeSettings,
  users,
} from "../src/infra/db/schema.js";

// Fixture mínima para os fluxos de comanda + caixa: usuários pelos 3 perfis
// que interessam, configuração com todos os métodos de pagamento, um produto
// (Chopp 300ml = R$ 9,50) e uma mesa ("1"). PINs são validados via argon2.
// Os PINs usados: 1234 para todos os perfis da fixture.
const FIXTURE_PINS = {
  waiter: "1234",
  manager: "1234",
  cashier: "1234",
  kitchen: "1234",
};

export const FIXTURE = {
  waiter: "u-waiter",
  manager: "u-manager",
  cashier: "u-cashier",
  kitchen: "u-kitchen",
  table: "t-1",
  product: "p-1",
  category: "c-1",
  kitchenGroup: "k-1",
};

// Escape hatch de SQL para os testes: o app inteiro usa Drizzle, mas as
// suítes às vezes precisam de UPDATE/SELECT cru (envelhecer um expires_at,
// corromper um payload de outbox, contar linhas). É o sucessor do
// `rawSqlite.prepare()` — mesmas três formas, agora via node-postgres.
export const raw = {
  /** SQL cru, múltiplos statements (o pool aceita lote simples). */
  exec: async (text: string): Promise<void> => {
    await pool.query(text);
  },
  /** Params posicionais `?` (o node-postgres usa $1, $2, ...). */
  all: async (text: string, params: unknown[] = []): Promise<any[]> => {
    const res = await pool.query(text, params as any[]);
    return res.rows;
  },
  get: async (text: string, params: unknown[] = []): Promise<any> => {
    const res = await pool.query(text, params as any[]);
    return res.rows[0] ?? null;
  },
};

// Tudo que a suíte pode sujar, exceto a fixture base (usuário, config,
// categoria, grupo de cozinha, produto, mesa) e o usuário `system` da
// migration. TRUNCATE ... CASCADE resolve a ordem das FKs de uma vez —
// inclusive as tabelas de infra que o SQLite listava à mão.
const TRANSIENT_TABLES = [
  "purchase_item",
  "purchase",
  "supplier",
  "payment_refund",
  "payment_event",
  "payment",
  "order_payment",
  "order_item",
  "cash_drawer_movement",
  "stock_movement",
  "audit_log",
  "idempotency_key",
  "outbox_event",
  "cash_drawer",
  "delivery",
  "courier_location",
  "customer_cart",
  "customer_address",
  "whatsapp_conversation",
  "whatsapp_outbound_message",
  "whatsapp_inbound_message",
  "whatsapp_connection",
  "geocoding_cache",
  "ifood_event",
  "ifood_state",
  "alert",
  "provisioning_key",
  "user_device",
  '"order"',
  "customer",
] as const;

// Zera o estado mutável entre testes, mantendo a fixture base. Só o que a
// suíte criou é derrubado: `store_settings`, os usuários, a categoria, o
// grupo de cozinha, o produto e a mesa da fixture sobrevivem — inclusive os
// toggles de rollout que um `beforeAll` liga (o estoque depende de
// `inventory_enabled = true`, o self-service do modo com cozinha).
export async function resetState() {
  resetCache();
  resetRateLimit();
  // O authMiddleware cacheia user.active por ~30s (docs/21 §5.4); entre
  // testes o banco pode ter mudado (ex.: um usuário desativado e reativado
  // por SQL cru), então o cache precisa nascer zerado.
  clearActiveUserCache();
  await raw.exec(`TRUNCATE ${TRANSIENT_TABLES.join(", ")} CASCADE`);
  // Reativa os usuários da fixture (alguns testes desativam u-manager)
  await db
    .update(users)
    .set({ active: true, failedAttempts: 0, lockedUntil: null })
    .where(or(
      eq(users.id, FIXTURE.waiter),
      eq(users.id, FIXTURE.manager),
      eq(users.id, FIXTURE.cashier),
      eq(users.id, FIXTURE.kitchen),
    ));
  // A mesa volta "free" (um teste anterior pode ter ocupado).
  await db
    .update(restaurantTables)
    .set({ status: "free" })
    .where(eq(restaurantTables.id, FIXTURE.table));
}

// `ip` injeta X-Forwarded-For (o app roda com trustProxy: 1) — necessário
// pros testes que exercitam as rotas públicas: elas têm rate limit por IP
// (5 pedidos/min pra POST /public/orders), então cada teste precisa do seu
// próprio "cliente" pra não se auto-bloquear.
// `headers` é o escape pra headers de domínio.
export async function api(
  method: "get" | "post" | "put" | "patch" | "delete",
  url: string,
  opts: { token?: string; body?: any; ip?: string; headers?: Record<string, string> } = {}
): Promise<ApiResult> {
  const res = await (await testApp()).inject({
    method,
    url,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}),
      ...(opts.headers ?? {}),
    },
    payload: opts.body,
  });
  let json: any = null;
  if (res.statusCode !== 204 && res.body.length > 0) {
    try {
      json = res.json();
    } catch {
      json = null;
    }
  }
  return { status: res.statusCode, json, body: res.body };
}

export function tokenOf(userId: string, role: string) {
  return jwt.sign({ sub: userId, role }, config.jwtSecret);
}

export const cashier = tokenOf(FIXTURE.cashier, "cashier");
export const manager = tokenOf(FIXTURE.manager, "manager");
export const waiter = tokenOf(FIXTURE.waiter, "waiter");
export const kitchen = tokenOf(FIXTURE.kitchen, "kitchen");

// Funções auxiliares usadas pelas suítes de teste
let _testApp: FastifyInstance | undefined;

export async function testApp(): Promise<FastifyInstance> {
  if (!_testApp) _testApp = await buildApp();
  return _testApp;
}

export async function closeTestApp() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let _app: FastifyInstance | undefined;
}

// Seed da fixture base + migrations. Chamado em beforeAll de cada suíte.
export async function seedFixture() {
  // Reset do cache e rodada de migrations
  resetCache();
  await runMigrations();

  // Singleton (id 'singleton'): UPSERT para deixar a linha IGUAL em todos os
  // arquivos de teste que chamam seedFixture. O arbiter é a PK `id` — é para
  // ele que todos os testes raw apontam.
  await db
    .insert(storeSettings)
    .values({
      id: "singleton",
      merchantName: "Teste Café",
      merchantCity: "Sao Paulo",
      enabledPaymentMethods: JSON.stringify(["cash", "card", "pix", "other"]),
      usesDelivery: false,
    })
    .onConflictDoUpdate({
      target: storeSettings.id,
      set: {
        merchantName: "Teste Café",
        merchantCity: "Sao Paulo",
        enabledPaymentMethods: JSON.stringify(["cash", "card", "pix", "other"]),
        usesDelivery: false,
      },
    });

  // Usuários da fixture com PINs hashdeados via argon2
  await db
    .insert(users)
    .values([
      { id: FIXTURE.waiter, name: "Garçom Teste", role: "waiter", pinHash: await argon2.hash(FIXTURE_PINS.waiter) },
      { id: FIXTURE.manager, name: "Gerente Teste", role: "manager", pinHash: await argon2.hash(FIXTURE_PINS.manager) },
      { id: FIXTURE.cashier, name: "Caixa Teste", role: "cashier", pinHash: await argon2.hash(FIXTURE_PINS.cashier) },
      { id: FIXTURE.kitchen, name: "Cozinha Teste", role: "kitchen", pinHash: await argon2.hash(FIXTURE_PINS.kitchen) },
    ])
    .onConflictDoNothing();

  await db
    .insert(categories)
    .values({ id: FIXTURE.category, name: "Bebidas" })
    .onConflictDoNothing();
  await db
    .insert(kitchenGroups)
    .values({ id: FIXTURE.kitchenGroup, name: "Bar" })
    .onConflictDoNothing();
  await db
    .insert(products)
    .values({
      id: FIXTURE.product,
      name: "Chopp 300ml",
      price: 9.5,
      categoryId: FIXTURE.category,
      kitchenGroupId: FIXTURE.kitchenGroup,
    })
    .onConflictDoNothing();
  await db
    .insert(restaurantTables)
    .values({ id: FIXTURE.table, number: "1" })
    .onConflictDoNothing();
}