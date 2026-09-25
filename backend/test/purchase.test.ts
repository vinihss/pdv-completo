import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, manager, FIXTURE } from "./helpers.js";
import { rawSqlite } from "../src/infra/db/client.js";

const PROD = { id: "p-pur", name: "Malte lúpulo", price: 15, costPrice: 8, threshold: 2, stock: 20 };

function outbox(room: string, type: string) {
  return rawSqlite
    .prepare(
      `SELECT payload FROM outbox_event WHERE room = ? AND event_type = ? AND published = 0`
    )
    .all(room, type) as { payload: string }[];
}
function audits(action: string) {
  return rawSqlite
    .prepare(`SELECT details FROM audit_log WHERE action = ?`)
    .all(action) as { details: string }[];
}

describe("compras e custo médio (0017)", () => {
  beforeAll(() => {
    seedFixture();
    rawSqlite.exec(`
      UPDATE store_settings SET inventory_enabled = 1, purchase_enabled = 1;
      INSERT OR IGNORE INTO product (id, name, price, category_id, kitchen_group_id, track_stock, low_stock_threshold, cost_price)
        VALUES ('${PROD.id}', '${PROD.name}', ${PROD.price}, '${FIXTURE.category}', '${FIXTURE.kitchenGroup}', 1, ${PROD.threshold}, ${PROD.costPrice});
    `);
  });
  afterAll(() => closeTestApp());
  beforeEach(() => {
    resetState();
    rawSqlite.exec(`
      INSERT INTO stock_movement (id, product_id, type, quantity_delta, unit_cost, note, created_by)
        VALUES ('sm-init', '${PROD.id}', 'adjustment', ${PROD.stock}, ${PROD.costPrice}, 'Estoque inicial', '${FIXTURE.manager}');
    `);
  });

  it("cria fornecedor e retorna id/nome", async () => {
    const res = await api("post", "/suppliers", {
      token: manager,
      body: { name: "Cervejaria X", phone: "11999990000", taxId: "12.345.678/0001-90" },
    });
    expect(res.status).toBe(201);
    expect(res.json.name).toBe("Cervejaria X");
    expect(res.json.id).toBeTruthy();
  });

  it("lista/atualiza/desativa fornecedor", async () => {
    const created = await api("post", "/suppliers", { token: manager, body: { name: "Y" } });
    const id = created.json.id;
    const upd = await api("patch", `/suppliers/${id}`, { token: manager, body: { phone: "11", active: false } });
    expect(upd.status).toBe(200);
    expect(upd.json.phone).toBe("11");
    expect(upd.json.active).toBe(false);
    const list = await api("get", "/suppliers", { token: manager });
    expect(list.json.data.some((s: any) => s.id === id && !s.active)).toBe(true);
    expect(audits("supplier_updated").some((a) => JSON.parse(a.details).supplierId === id)).toBe(true);
  });

  it("rejeita compra sem itens e produto sem track_stock", async () => {
    const bad = await api("post", "/purchases", {
      token: manager,
      body: { correlationId: crypto.randomUUID(), items: [] },
    });
    expect(bad.status).toBe(400);

    const res = await api("post", "/purchases", {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        items: [{ productId: FIXTURE.product, quantity: 1, unitCost: 1 }],
      },
    });
    expect(res.status).toBe(400);
  });

  it("compra multi-item gera ledger de valoração + audit + evento realtime", async () => {
    const supp = await api("post", "/suppliers", { token: manager, body: { name: "Forn A" } });
    const corr = crypto.randomUUID();
    const res = await api("post", "/purchases", {
      token: manager,
      body: {
        supplierId: supp.json.id,
        invoiceNumber: "NF-123",
        issuedOn: "2026-01-02",
        note: "nota teste",
        correlationId: corr,
        items: [
          { productId: PROD.id, quantity: 10, unitCost: 9, batchNo: "L1", expiryDate: "2027-01-01" },
          { productId: PROD.id, quantity: 5, unitCost: 10 },
        ],
      },
    });
    expect(res.status).toBe(201);
    expect(res.json.total).toBeCloseTo(10 * 9 + 5 * 10);
    expect(res.json.invoiceNumber).toBe("NF-123");
    expect(res.json.items).toHaveLength(2);
    expect(res.json.items[0].lineTotal).toBeCloseTo(90);
    expect(res.json.items[1].lineTotal).toBeCloseTo(50);

    // Ledger: 2 movimentos purchase (um por linha)
    const moves = rawSqlite
      .prepare("SELECT * FROM stock_movement WHERE product_id = ? AND type = 'purchase'")
      .all(PROD.id) as any[];
    expect(moves).toHaveLength(2);
    expect(moves[0].unit_cost).toBe(9);
    expect(moves[1].unit_cost).toBe(10);
    expect(moves[0].purchase_item_id).toBeTruthy();

    // Média móvel: ((8×20)+(9×10)+(10×5))/35 = (160+90+50)/35 = 300/35 ≈ 8.571
    const avg = ((8 * 20 + 9 * 10 + 10 * 5) / 35);
    expect(res.json.averages[PROD.id]).toBeCloseTo(avg);
    // product.cost_price espelhado
    const prod = rawSqlite.prepare("SELECT cost_price FROM product WHERE id = ?").get(PROD.id) as any;
    expect(prod.cost_price).toBeCloseTo(avg);

    // Audit + outbox
    expect(audits("purchase_received").some((a) => JSON.parse(a.details).purchaseId === res.json.id)).toBe(true);
    expect(outbox("inventory", "purchase.received").length).toBeGreaterThanOrEqual(1);
  });

  it("replay idempotente do documento de compra retorna o mesmo", async () => {
    const corr = crypto.randomUUID();
    const a = await api("post", "/purchases", {
      token: manager,
      body: { correlationId: corr, items: [{ productId: PROD.id, quantity: 2, unitCost: 7 }] },
    });
    const b = await api("post", "/purchases", {
      token: manager,
      body: { correlationId: corr, items: [{ productId: PROD.id, quantity: 2, unitCost: 7 }] },
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json.id).toBe(a.json.id);
  });

  it("valorização do estoque e consumo reduzem valor", async () => {
    await api("post", "/suppliers", { token: manager, body: { name: "F V" } });
    await api("post", "/purchases", {
      token: manager,
      body: { correlationId: crypto.randomUUID(), items: [{ productId: PROD.id, quantity: 5, unitCost: 10 }] },
    });
    const val = await api("get", "/inventory/value", { token: manager });
    // baseline 20×8 + 5×10 = 160+50; avg = 210/25 = 8.4; value = 25×8.4 = 210
    expect(val.json.totalValue).toBeCloseTo(210);
    const row = val.json.data.find((p: any) => p.productId === PROD.id);
    expect(row.quantity).toBe(25);
    expect(row.averageCost).toBeCloseTo(8.4);
    expect(row.value).toBeCloseTo(210);
  });

  it("snapshot de custo na venda usa a média móvel (não o custo manual)", async () => {
    await api("post", "/suppliers", { token: manager, body: { name: "F V2" } });
    await api("post", "/purchases", {
      token: manager,
      body: { correlationId: crypto.randomUUID(), items: [{ productId: PROD.id, quantity: 5, unitCost: 12 }] },
    });
    const order = await api("post", "/orders", { token: manager, body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table } });
    const add = await api("post", `/orders/${order.json.id}/items`, {
      token: manager,
      body: { correlationId: crypto.randomUUID(), items: [{ productId: PROD.id, quantity: 1 }] },
    });
    expect(add.status).toBe(201);
    // média: baseline 20×8 + 5×12 = 220/25 = 8.8
    expect(add.json.data[0].costPrice).toBeCloseTo(8.8);
    expect(add.json.data[0].costPrice).not.toBe(PROD.costPrice);
  });
});