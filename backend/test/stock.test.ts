import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, manager, waiter, FIXTURE } from "./helpers.js";
import { rawSqlite } from "../src/infra/db/client.js";

// Produto controlado pela suíte de estoque (separado do Chopp da fixture
// global, que permanece sem rastreamento pros outras suítes não regredirem).
const TRACKED = {
  id: "p-stock",
  name: "Batata frita",
  price: 22,
  threshold: 5,
  baseline: 10,
};

// Sem `published` no filtro: o dispatcher marca `published = 1` ao despachar, e
// isso é detalhe de entrega, não do contrato de emissão (ver guard de main() em
// src/http/server.ts — nos testes o outbox só cresce por enqueueEvent).
function outboxTypes(room: string): string[] {
  const rows = rawSqlite
    .prepare(`SELECT event_type FROM outbox_event WHERE room = ? ORDER BY rowid`)
    .all(room) as { event_type: string }[];
  return rows.map((r) => r.event_type);
}

function outboxPayloads(room: string, eventType: string): any[] {
  const rows = rawSqlite
    .prepare(`SELECT payload FROM outbox_event WHERE room = ? AND event_type = ? ORDER BY rowid`)
    .all(room, eventType) as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload));
}

// Saldo atual via ledger — mesmo cálculo do backend (soma dos deltas).
function balance(productId: string): number {
  const row = rawSqlite
    .prepare(`SELECT COALESCE(SUM(quantity_delta), 0) AS total FROM stock_movement WHERE product_id = ?`)
    .get(productId) as { total: number };
  return row.total;
}

async function openOrder(): Promise<string> {
  const res = await api("post", "/orders", {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
  });
  return res.json.id;
}

async function addItems(orderId: string, productId: string, quantity: number) {
  return api("post", `/orders/${orderId}/items`, {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), items: [{ productId, quantity }] },
  });
}

describe("estoque por produto (0016)", () => {
  beforeAll(() => {
    seedFixture();
    // Habilita a feature global e cria o produto rastreado + estoque inicial.
    rawSqlite.exec(`
      UPDATE store_settings SET inventory_enabled = 1;
      INSERT OR IGNORE INTO product (id, name, price, category_id, kitchen_group_id, track_stock, low_stock_threshold, cost_price)
        VALUES ('${TRACKED.id}', '${TRACKED.name}', ${TRACKED.price}, '${FIXTURE.category}', '${FIXTURE.kitchenGroup}', 1, ${TRACKED.threshold}, 7);
    `);
  });
  afterAll(() => closeTestApp());
  beforeEach(() => {
    resetState();
    rawSqlite.exec(`
      INSERT INTO stock_movement (id, product_id, type, quantity_delta, note, created_by)
        VALUES ('sm-baseline', '${TRACKED.id}', 'adjustment', ${TRACKED.baseline}, 'Estoque inicial', '${FIXTURE.manager}');
    `);
  });

  it("lançar item consome o saldo e emite stock.movement pro room inventory", async () => {
    const orderId = await openOrder();
    const res = await addItems(orderId, TRACKED.id, 2);
    expect(res.status).toBe(201);
    expect(balance(TRACKED.id)).toBe(TRACKED.baseline - 2);

    const stock = await api("get", "/stock", { token: manager });
    const row = stock.json.data.find((p: any) => p.productId === TRACKED.id);
    expect(row.quantity).toBe(8);

    expect(outboxTypes("inventory")).toContain("stock.movement");
    const sale = outboxPayloads("inventory", "stock.movement").pop();
    expect(sale.type).toBe("sale");
    expect(sale.quantityDelta).toBe(-2);
  });

  it("estoque insuficiente bloqueia o lançamento (409 insufficient_stock) e dá rollback", async () => {
    const orderId = await openOrder();
    const res = await addItems(orderId, TRACKED.id, TRACKED.baseline + 1);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("insufficient_stock");
    expect(res.json.error.details.available).toBe(TRACKED.baseline);
    // Rollback: saldo intacto, comanda sem itens, sem evento de item criado.
    expect(balance(TRACKED.id)).toBe(TRACKED.baseline);
    const order = await api("get", `/orders/${orderId}`, { token: waiter });
    expect(order.json.items).toHaveLength(0);
    expect(outboxTypes("table:1")).not.toContain("order.item.created");
  });

  it("remover item devolve ao estoque (refund)", async () => {
    const orderId = await openOrder();
    const added = await addItems(orderId, TRACKED.id, 3);
    const itemId = added.json.data[0].id;
    const del = await api("delete", `/orders/${orderId}/items/${itemId}`, { token: waiter });
    expect(del.status).toBe(204);
    expect(balance(TRACKED.id)).toBe(TRACKED.baseline);
    const refund = outboxPayloads("inventory", "stock.movement").pop();
    expect(refund.type).toBe("refund");
    expect(refund.quantityDelta).toBe(3);
  });

  it("cancelar comanda estorna o estoque", async () => {
    const orderId = await openOrder();
    await addItems(orderId, TRACKED.id, 4);
    const cancel = await api("patch", `/orders/${orderId}/cancel`, {
      token: manager,
      body: { correlationId: crypto.randomUUID(), reason: "não veio" },
    });
    expect(cancel.status).toBe(200);
    expect(balance(TRACKED.id)).toBe(TRACKED.baseline);
  });

  it("movimento manual (compra) atualiza saldo e registra audit", async () => {
    const res = await api("post", `/stock/${TRACKED.id}/movements`, {
      token: manager,
      body: { correlationId: crypto.randomUUID(), type: "purchase", quantity: 5, note: "reposição" },
    });
    expect(res.status).toBe(200);
    expect(balance(TRACKED.id)).toBe(TRACKED.baseline + 5);

    const audit = await api("get", "/audit-log", { token: manager });
    expect(audit.json.data.some((l: any) => l.action === "stock_movement_manual" && l.details.productId === TRACKED.id)).toBe(true);
  });

  it("ajuste manual negativo reduz o saldo e não aceita zero", async () => {
    const adj = await api("post", `/stock/${TRACKED.id}/movements`, {
      token: manager,
      body: { correlationId: crypto.randomUUID(), type: "adjustment", quantity: -3, note: "perda" },
    });
    expect(adj.status).toBe(200);
    expect(balance(TRACKED.id)).toBe(TRACKED.baseline - 3);

    const zero = await api("post", `/stock/${TRACKED.id}/movements`, {
      token: manager,
      body: { correlationId: crypto.randomUUID(), type: "adjustment", quantity: 0 },
    });
    expect(zero.status).toBe(400);
  });

  it("estoque baixo emite stock.low quando o saldo cruza o limite", async () => {
    const orderId = await openOrder();
    // baseline 10, limite 5: lançar 6 cai pra 4 → cruza o limite
    await addItems(orderId, TRACKED.id, 6);
    expect(outboxTypes("inventory")).toContain("stock.low");
    const low = outboxPayloads("inventory", "stock.low").pop();
    expect(low.productId).toBe(TRACKED.id);
    expect(low.quantity).toBe(4);
    expect(low.threshold).toBe(TRACKED.threshold);
  });

  it("produto sem track_stock não é afetado mesmo com a feature global ligada", async () => {
    const orderId = await openOrder();
    const res = await addItems(orderId, FIXTURE.product, 1000);
    expect(res.status).toBe(201);
    // Chopp não rastreia → sem movimento no ledger
    expect(balance(FIXTURE.product)).toBe(0);
    expect(outboxPayloads("inventory", "stock.movement").some((m) => m.productId === FIXTURE.product)).toBe(false);

    const stock = await api("get", "/stock", { token: manager });
    expect(stock.json.data.some((p: any) => p.productId === FIXTURE.product)).toBe(false);
  });

  it("histórico de movimentos retorna produto, tipo e autor", async () => {
    const orderId = await openOrder();
    await addItems(orderId, TRACKED.id, 2);
    const history = await api("get", `/stock/movements?product_id=${TRACKED.id}`, { token: manager });
    const entries = history.json.data;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const sale = entries.find((m: any) => m.type === "sale");
    expect(sale).toBeTruthy();
    expect(sale.productName).toBe(TRACKED.name);
    expect(sale.quantityDelta).toBe(-2);
    expect(sale.userName).toBe("Garçom Teste");
  });

  it("com a feature global desligada não há débito nem bloqueio", async () => {
    rawSqlite.exec("UPDATE store_settings SET inventory_enabled = 0;");
    try {
      const orderId = await openOrder();
      const res = await addItems(orderId, TRACKED.id, TRACKED.baseline + 50);
      expect(res.status).toBe(201);
      expect(balance(TRACKED.id)).toBe(TRACKED.baseline); // nada foi debitado
    } finally {
      rawSqlite.exec("UPDATE store_settings SET inventory_enabled = 1;");
    }
  });
});