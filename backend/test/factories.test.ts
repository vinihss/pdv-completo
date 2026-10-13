import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  api,
  closeTestApp,
  resetState,
  seedFixture,
  createUser,
  createWaiter,
  createManager,
  createTable,
  createProduct,
  createCustomer,
  createOrder,
  createOrderItem,
  createOrderPayment,
  createCashDrawer,
  createStoreSettings,
  expectApiError,
  expectApiSuccess,
  expectOutboxEvent,
  getOutboxEventTypes,
} from "./helpers.js";

describe("Test Factories & Assertions (Fase 1)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("deve criar usuários dinamicamente com tokens JWT válidos", async () => {
    const customWaiter = await createWaiter({ name: "Garçom Dinâmico" });
    expect(customWaiter.id).toBeDefined();
    expect(customWaiter.token).toBeDefined();
    expect(customWaiter.role).toBe("waiter");

    const customManager = await createManager({ name: "Gerente Dinâmico" });
    expect(customManager.role).toBe("manager");

    const res = await api("get", "/auth/users", { token: customWaiter.token });
    expectApiSuccess(res, 200);
    expect(res.json.some((u: any) => u.id === customWaiter.id)).toBe(true);
  });

  it("deve criar mesas, produtos e categorias isoladamente", async () => {
    const table = await createTable({ number: "99" });
    const product = await createProduct({ name: "Hambúrguer Artesanal", price: 35.5 });

    expect(table.number).toBe("99");
    expect(product.price).toBe(35.5);
    expect(product.categoryId).toBeDefined();
  });

  it("deve criar clientes com dados customizados", async () => {
    const customer = await createCustomer({ name: "João Silva", phone: "11999998888" });
    expect(customer.name).toBe("João Silva");
    expect(customer.phone).toBe("11999998888");
  });

  it("deve criar pedidos, itens e pagamentos via factory", async () => {
    const waiterUser = await createWaiter();
    const table = await createTable({ number: "42" });
    const order = await createOrder({ waiterId: waiterUser.id, tableId: table.id });

    const item = await createOrderItem(order.id, { quantity: 3, unitPrice: 20 });
    const payment = await createOrderPayment(order.id, { amount: 60, method: "pix", confirmed: true });

    expect(order.id).toBeDefined();
    expect(item.quantity).toBe(3);
    expect(payment.amount).toBe(60);

    const res = await api("get", `/orders/${order.id}`, { token: waiterUser.token });
    expectApiSuccess(res, 200);
    expect(res.json.id).toBe(order.id);
  });

  it("deve validar asserções semânticas de erro e outbox", async () => {
    const waiterUser = await createWaiter();

    // Validar expectApiError
    const res = await api("post", "/orders", {
      token: waiterUser.token,
      body: { correlationId: crypto.randomUUID(), tableId: "mesa-inexistente" },
    });
    expectApiError(res, 404, "table_not_found");

    // Abrir comanda válida, adicionar item e verificar emissão de outbox
    const table = await createTable({ number: "77" });
    const product = await createProduct({ name: "Cerveja Artesanal", price: 18 });
    const openRes = await api("post", "/orders", {
      token: waiterUser.token,
      body: { correlationId: crypto.randomUUID(), tableId: table.id },
    });
    expectApiSuccess(openRes, 201);

    const itemRes = await api("post", `/orders/${openRes.json.id}/items`, {
      token: waiterUser.token,
      body: {
        correlationId: crypto.randomUUID(),
        items: [{ productId: product.id, quantity: 2 }],
      },
    });
    expectApiSuccess(itemRes, 201);

    const types = await getOutboxEventTypes("kitchen-display");
    expect(types).toContain("order.item.created");

    const event = await expectOutboxEvent("kitchen-display", "order.item.created");
    expect(event.payload).toBeDefined();
  });
});
