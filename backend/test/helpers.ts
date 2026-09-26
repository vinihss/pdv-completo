import jwt from "jsonwebtoken";
import type { FastifyInstance } from "fastify";
import { rawSqlite } from "../src/infra/db/client.js";
import { runMigrations } from "../src/infra/db/migrate.js";
import { buildApp } from "../src/http/server.js";
import { config } from "../src/config/env.js";
import { resetCache } from "../src/infra/cache/index.js";

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

export function tokenOf(userId: string, role: string) {
  return jwt.sign({ sub: userId, role }, config.jwtSecret);
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

export function seedFixture() {
  resetCache();
  runMigrations();
  // INSERT OR IGNORE: o banco persiste por toda a sessão de testes (só é
  // recriado no global setup), então múltiplos arquivos chamam seedFixture.
  rawSqlite.exec(`
    INSERT OR IGNORE INTO store_settings (id, merchant_name, merchant_city, enabled_payment_methods, uses_delivery)
      VALUES ('singleton', 'Teste Café', 'Sao Paulo', '["cash","card","pix","other"]', 0);
    INSERT OR IGNORE INTO "user" (id, name, role, pin_hash) VALUES
      ('${FIXTURE.waiter}',  'Garçom Teste',  'waiter',  'x'),
      ('${FIXTURE.manager}', 'Gerente Teste', 'manager', 'x'),
      ('${FIXTURE.cashier}', 'Caixa Teste',   'cashier', 'x'),
      ('${FIXTURE.kitchen}', 'Cozinha Teste', 'kitchen', 'x');
    INSERT OR IGNORE INTO category (id, name) VALUES ('${FIXTURE.category}', 'Bebidas');
    INSERT OR IGNORE INTO kitchen_group (id, name) VALUES ('${FIXTURE.kitchenGroup}', 'Bar');
    INSERT OR IGNORE INTO product (id, name, price, category_id, kitchen_group_id)
      VALUES ('${FIXTURE.product}', 'Chopp 300ml', 9.5, '${FIXTURE.category}', '${FIXTURE.kitchenGroup}');
    INSERT OR IGNORE INTO restaurant_table (id, number) VALUES ('${FIXTURE.table}', '1');
  `);
}

// Zera o estado mutável entre testes, mantendo a fixture base. A ordem dos
// DELETEs respeita as FKs (movimento/audit referenciam order e cash_drawer).
export function resetState() {
  resetCache();
  rawSqlite.exec(`
    DELETE FROM purchase_item;
    DELETE FROM purchase;
    DELETE FROM supplier;
    DELETE FROM order_payment;
    DELETE FROM order_item;
    DELETE FROM cash_drawer_movement;
    DELETE FROM stock_movement;
    DELETE FROM audit_log;
    DELETE FROM idempotency_key;
    DELETE FROM outbox_event;
    DELETE FROM cash_drawer;
    DELETE FROM "order";
    DELETE FROM customer_cart;
    DELETE FROM customer_address;
    DELETE FROM whatsapp_conversation;
    DELETE FROM customer;
    UPDATE restaurant_table SET status = 'free' WHERE id = '${FIXTURE.table}';
  `);
}

export type ApiResult = { status: number; json: any; body: string };

// `ip` injeta X-Forwarded-For (o app roda com trustProxy: 1) — necessário
// pros testes que exercitam as rotas públicas: elas têm rate limit por IP
// (5 pedidos/min pra POST /public/orders), então cada teste precisa do seu
// próprio "cliente" pra não se auto-bloquear.
export async function api(
  method: "get" | "post" | "put" | "patch" | "delete",
  url: string,
  opts: { token?: string; body?: any; ip?: string } = {}
): Promise<ApiResult> {
  const res = await (await testApp()).inject({
    method,
    url,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}),
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

export const cashier = tokenOf(FIXTURE.cashier, "cashier");
export const manager = tokenOf(FIXTURE.manager, "manager");
export const waiter = tokenOf(FIXTURE.waiter, "waiter");
export const kitchen = tokenOf(FIXTURE.kitchen, "kitchen");