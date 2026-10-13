import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  api,
  seedFixture,
  resetState,
  closeTestApp,
  cashier,
  manager,
  waiter,
  kitchen,
  FIXTURE,
  getOutboxEventTypes,
  expectApiError,
  expectApiSuccess,
} from "./helpers.js";

const openDrawer = (correlationId: string, openingAmount: number) =>
  api("post", "/cash-drawer/open", { token: cashier, body: { correlationId, openingAmount } });

async function openOrder(): Promise<{ orderId: string; itemId: string }> {
  const res = await api("post", "/orders", {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
  });
  expectApiSuccess(res, 201);
  const orderId = res.json.id;
  const items = await api("post", `/orders/${orderId}/items`, {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), items: [{ productId: FIXTURE.product, quantity: 2 }] },
  });
  expectApiSuccess(items, 201);
  return { orderId, itemId: items.json.data[0].id };
}

// Fecha uma comanda no fluxo completo (cozinha marca pronto → entrega → paga → fecha).
async function closeOrder(orderId: string, itemId: string) {
  await api("patch", `/orders/${orderId}/items/${itemId}`, {
    token: kitchen,
    body: { status: "ready", expectedVersion: 1 },
  });
  await api("patch", `/orders/${orderId}/items/${itemId}`, {
    token: waiter,
    body: { status: "delivered", expectedVersion: 2 },
  });
  await openDrawer(crypto.randomUUID(), 100);
  await api("put", `/orders/${orderId}/payments`, {
    token: waiter,
    body: { payments: [{ method: "cash", amount: 19, received: 20, confirmed: true }] },
  });
  const close = await api("patch", `/orders/${orderId}/close`, {
    token: waiter,
    body: { correlationId: crypto.randomUUID() },
  });
  return close;
}

describe("validação de mesa ao abrir comanda (1.6)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("mesa inexistente → 404 table_not_found", async () => {
    const res = await api("post", "/orders", {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), tableId: "mesa-que-nao-existe" },
    });
    expectApiError(res, 404, "table_not_found");
  });

  it("mesa ocupada → 409 table_occupied (não 500/duplicidade)", async () => {
    const first = await api("post", "/orders", {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
    });
    expectApiSuccess(first, 201);

    const second = await api("post", "/orders", {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
    });
    expectApiError(second, 409, "table_occupied");
  });
});

describe("realtime de comandas (1.2 / 1.8)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("deletar item emite order.item.removed para kitchen-display", async () => {
    const { orderId, itemId } = await openOrder();
    const del = await api("delete", `/orders/${orderId}/items/${itemId}`, { token: waiter });
    expect(del.status).toBe(204);
    expect(await getOutboxEventTypes("kitchen-display")).toContain("order.item.removed");
  });

  it("registrar e confirmar pagamento emite order.payment_changed para kitchen-display", async () => {
    const { orderId } = await openOrder();
    await openDrawer(crypto.randomUUID(), 100);
    await api("put", `/orders/${orderId}/payments`, {
      token: waiter,
      body: { payments: [{ method: "cash", amount: 19, received: 20, confirmed: true }] },
    });
    expect(await getOutboxEventTypes("kitchen-display")).toContain("order.payment_changed");
    expect(await getOutboxEventTypes("cash-drawer")).toContain("order.payment_changed");
  });

  it("fechar comanda emite order.closed para kitchen-display (1.2)", async () => {
    const { orderId, itemId } = await openOrder();
    const close = await closeOrder(orderId, itemId);
    expectApiSuccess(close, 200);
    expect(await getOutboxEventTypes("kitchen-display")).toContain("order.closed");
  });

  it("cancelar comanda emite order.cancelled para kitchen-display (1.2)", async () => {
    const { orderId } = await openOrder();
    const cancel = await api("patch", `/orders/${orderId}/cancel`, {
      token: manager,
      body: { correlationId: crypto.randomUUID(), reason: "teste" },
    });
    expectApiSuccess(cancel, 200);
    expect(await getOutboxEventTypes("kitchen-display")).toContain("order.cancelled");
  });
});