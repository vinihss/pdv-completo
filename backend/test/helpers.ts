import jwt from "jsonwebtoken";
import type { FastifyInstance } from "fastify";
import { eq, or } from "drizzle-orm";
import { db, pool } from "../src/infra/db/client.js";
import { runMigrations } from "../src/infra/db/migrate.js";
import { buildApp } from "../src/http/server.js";
import { config } from "../src/config/env.js";
import { resetCache } from "../src/infra/cache/index.js";
import { clearActiveUserCache } from "../src/infra/auth/active-user-check.js";
import { runInTenantScope } from "../src/infra/db/tenant-context.js";
import { resolveTenant } from "../src/application/tenant/resolve-tenant.usecase.js";
import {
  categories,
  kitchenGroups,
  products,
  restaurantTables,
  storeSettings,
  users,
} from "../src/infra/db/schema.js";

let _app: FastifyInstance | undefined;

export async function testApp(): Promise<FastifyInstance> {
  if (!_app) _app = await buildApp();
  return _app;
}

export async function closeTestApp() {
  if (_app) {
    await _app.close();
    _app = undefined;
  }
}

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

export function tokenOf(userId: string, role: string, tenant: string = "default") {
  return jwt.sign({ sub: userId, role, tenant }, config.jwtSecret);
}

// Fixture mínima para os fluxos de comanda + caixa: usuários pelos 3 perfis
// que interessam, configuração com todos os métodos de pagamento, um produto
// (Chopp 300ml = R$ 9,50) e uma mesa ("1"). PINs não importam: os testes usam
// tokens JWT assinados diretamente.
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

export async function seedFixture() {
  resetCache();
  await runMigrations();

  // O banco persiste por toda a sessão de testes (só é recriado no global
  // setup), então múltiplos arquivos chamam seedFixture — e a linha precisa
  // ficar IGUAL em todos.
  //
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

  await db
    .insert(users)
    .values([
      { id: FIXTURE.waiter, name: "Garçom Teste", role: "waiter", pinHash: "x" },
      { id: FIXTURE.manager, name: "Gerente Teste", role: "manager", pinHash: "x" },
      { id: FIXTURE.cashier, name: "Caixa Teste", role: "cashier", pinHash: "x" },
      { id: FIXTURE.kitchen, name: "Cozinha Teste", role: "kitchen", pinHash: "x" },
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

export type ApiResult = { status: number; json: any; body: string };

// `ip` injeta X-Forwarded-For (o app roda com trustProxy: 1) — necessário
// pros testes que exercitam as rotas públicas: elas têm rate limit por IP
// (5 pedidos/min pra POST /public/orders), então cada teste precisa do seu
// próprio "cliente" pra não se auto-bloquear.
// `headers` é o escape pra headers de domínio.
// Entra no escopo do tenant antes do `inject()` — o ALS do Fastify não
// propaga de forma confiável até o handler no `inject()`, e o hook `onRoute`
// do server cobre o caminho normal. Quando o host NÃO resolve tenant (o caso
// do teste de host inexistente, que espera o 404 `tenant_not_resolved`), NÃO
// entra no escopo: o hook `onRequest` da rota resolve e devolve o erro pelo
// error handler. Resolver aqui incondicionalmente quebraria esse caminho.
async function withResolvedTenantScope<T>(host: string | undefined, fn: () => Promise<T>): Promise<T> {
  let scope: { schemaName: string; slug: string; isDefault: boolean } | null = null;
  try {
    const tenant = await resolveTenant(host);
    scope = { schemaName: tenant.schemaName, slug: tenant.slug, isDefault: tenant.isDefault };
  } catch {
    scope = null;
  }
  return scope ? runInTenantScope(scope, fn) : fn();
}

export async function api(
  method: "get" | "post" | "put" | "patch" | "delete",
  url: string,
  opts: { token?: string; body?: any; ip?: string; headers?: Record<string, string> } = {}
): Promise<ApiResult> {
  const host = opts.headers?.["x-tenant-host"] || opts.headers?.["host"];

  const res = await withResolvedTenantScope(host, async () =>
    (await testApp()).inject({
      method,
      url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}),
        ...(opts.headers ?? {}),
      },
      payload: opts.body,
    })
  );

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

// Helper para upload de arquivos (multipart/form-data) que configura o ALS corretamente.
// Similar ao `api()`, mas para requests com FormData/multipart.
export async function upload(
  url: string,
  opts: { token?: string; form?: any; ip?: string; headers?: Record<string, string> } = {}
): Promise<{ statusCode: number; json: () => any; body: string }> {
  const host = opts.headers?.["x-tenant-host"] || opts.headers?.["host"];

  return await withResolvedTenantScope(host, async () =>
    (await testApp()).inject({
      method: "POST",
      url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}),
        ...(opts.headers ?? {}),
      },
      payload: opts.form,
    })
  );
}

export const cashier = tokenOf(FIXTURE.cashier, "cashier");
export const manager = tokenOf(FIXTURE.manager, "manager");
export const waiter = tokenOf(FIXTURE.waiter, "waiter");
export const kitchen = tokenOf(FIXTURE.kitchen, "kitchen");
