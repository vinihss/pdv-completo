import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, tokenOf, cashier, waiter, manager, FIXTURE } from "./helpers.js";
import { rawSqlite } from "../src/infra/db/client.js";

// Perfis caixa e entregador ("implementar perfis de usuário: caixa, entregador"):
// - tela de login respeita os toggles de rollout (kitchen_enabled / uses_delivery);
// - caixa acessa o fluxo de caixa, mas não gerência/comandas;
// - entregador acessa só as próprias entregas;
// - gerente cria entregador (PIN devolvido uma vez), e o fluxo de entrega
//   assign → dispatch → deliver fecha a comanda do delivery.

const COURIER_ID = "u-courier";
const courier = tokenOf(COURIER_ID, "courier");

function setStoreFlag(column: "uses_delivery" | "kitchen_enabled", value: boolean) {
  rawSqlite.prepare(`UPDATE store_settings SET ${column} = ? WHERE id = 'singleton'`).run(value ? 1 : 0);
}

async function loginSurface(): Promise<Array<{ id: string; name: string; role: string }>> {
  const res = await api("get", "/auth/users");
  return res.json;
}

// Cria um pedido self-service (rota pública) com entrega já no status inicial
// "awaiting_courier" — é o jeito de nascer uma entrega no sistema.
async function createDeliveryOrder() {
  const res = await api("post", "/public/orders", {
    body: {
      correlationId: crypto.randomUUID(),
      channel: "web",
      customerPhone: "11988887777",
      customerName: "Cliente Entrega",
      newAddress: {
        street: "Rua das Flores",
        number: "123",
        neighborhood: "Centro",
        city: "Sao Paulo",
      },
      items: [{ productId: FIXTURE.product, quantity: 1 }],
      paymentMethodIntent: "card",
    },
  });
  expect(res.status).toBe(201);
  return { orderId: res.json.orderId as string, deliveryId: res.json.deliveryId as string };
}

describe("tela de login por perfil (GET /auth/users)", () => {
  beforeAll(() => {
    seedFixture();
    rawSqlite.prepare(`INSERT OR IGNORE INTO "user" (id, name, role, pin_hash) VALUES (?, 'Entregador Teste', 'courier', 'x')`).run(COURIER_ID);
  });
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("esconde entregador quando uses_delivery está desligado (e cozinha quando desligada)", async () => {
    setStoreFlag("uses_delivery", false);
    setStoreFlag("kitchen_enabled", false);
    const users = await loginSurface();
    const roles = users.map((u) => u.role);
    expect(roles).toContain("waiter");
    expect(roles).toContain("manager");
    expect(roles).toContain("cashier");
    expect(roles).not.toContain("courier");
    expect(roles).not.toContain("kitchen");
  });

  it("mostra entregador quando uses_delivery está ligado", async () => {
    setStoreFlag("uses_delivery", true);
    setStoreFlag("kitchen_enabled", false);
    const roles = (await loginSurface()).map((u) => u.role);
    expect(roles).toContain("courier");
    expect(roles).not.toContain("kitchen");
  });
});

describe("acesso por papel — caixa (cashier)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("caixa acessa o fluxo de caixa, mas não gerência, comandas nem entregas", async () => {
    const drawer = await api("get", "/cash-drawer/current", { token: cashier });
    expect(drawer.status).toBe(200);

    const users = await api("get", "/users", { token: cashier });
    expect(users.status).toBe(403);
    expect(users.json.error.code).toBe("forbidden_role");

    const orders = await api("post", "/orders", {
      token: cashier,
      body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
    });
    expect(orders.status).toBe(403);

    const deliveries = await api("get", "/manager/deliveries", { token: cashier });
    expect(deliveries.status).toBe(403);
  });
});

describe("acesso por papel — entregador (courier)", () => {
  beforeAll(() => {
    seedFixture();
    rawSqlite.prepare(`INSERT OR IGNORE INTO "user" (id, name, role, pin_hash) VALUES (?, 'Entregador Teste', 'courier', 'x')`).run(COURIER_ID);
  });
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("entregador acessa as próprias entregas, mas não comandas/gerência/caixa", async () => {
    const deliveries = await api("get", "/courier/deliveries", { token: courier });
    expect(deliveries.status).toBe(200);
    expect(deliveries.json).toEqual([]);

    const orders = await api("post", "/orders", {
      token: courier,
      body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
    });
    expect(orders.status).toBe(403);

    const users = await api("get", "/users", { token: courier });
    expect(users.status).toBe(403);

    const drawer = await api("get", "/cash-drawer/current", { token: courier });
    expect(drawer.status).toBe(403);
  });
});

describe("gerente cadastra entregador", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("POST /users (role courier) devolve o PIN uma vez e o entregador consegue logar", async () => {
    const created = await api("post", "/users", { token: manager, body: { name: "Entregador Novo", role: "courier" } });
    expect(created.status).toBe(201);
    expect(created.json.pin).toMatch(/^\d{4}$/);

    const login = await api("post", "/auth/login", { body: { userId: created.json.id, pin: created.json.pin } });
    expect(login.status).toBe(200);
    expect(login.json.user.role).toBe("courier");
    expect(login.json.token).toBeTruthy();

    const deliveries = await api("get", "/courier/deliveries", { token: login.json.token });
    expect(deliveries.status).toBe(200);
    expect(deliveries.json).toEqual([]);
  });
});

describe("fluxo completo de entrega — assign → dispatch → deliver", () => {
  beforeAll(() => {
    seedFixture();
    rawSqlite.prepare(`INSERT OR IGNORE INTO "user" (id, name, role, pin_hash) VALUES (?, 'Entregador Teste', 'courier', 'x')`).run(COURIER_ID);
  });
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("manager atribui, entregador confirma saída, entrega e a comanda fecha", async () => {
    setStoreFlag("uses_delivery", true);

    const { orderId, deliveryId } = await createDeliveryOrder();

    const managerList = await api("get", "/manager/deliveries", { token: manager });
    expect(managerList.status).toBe(200);
    const pending = managerList.json.find((d: any) => d.id === deliveryId);
    expect(pending.status).toBe("awaiting_courier");
    expect(pending.courier).toBeNull();

    const assign = await api("patch", `/manager/deliveries/${deliveryId}/assign`, {
      token: manager,
      body: { courierId: COURIER_ID },
    });
    expect(assign.status).toBe(200);
    expect(assign.json.courierId).toBe(COURIER_ID);

    const myList = await api("get", "/courier/deliveries", { token: courier });
    expect(myList.status).toBe(200);
    expect(myList.json).toHaveLength(1);
    expect(myList.json[0]).toMatchObject({ id: deliveryId, status: "awaiting_courier" });

    const dispatch = await api("patch", `/courier/deliveries/${deliveryId}/dispatch`, { token: courier });
    expect(dispatch.status).toBe(200);
    expect(dispatch.json.status).toBe("out_for_delivery");

    const deliver = await api("patch", `/courier/deliveries/${deliveryId}/deliver`, { token: courier });
    expect(deliver.status).toBe(200);
    expect(deliver.json.status).toBe("delivered");

    const order = await api("get", `/orders/${orderId}`, { token: waiter });
    expect(order.status).toBe(200);
    expect(order.json.status).toBe("closed");
  });

  it("entregador não mexe numa entrega que não é dele", async () => {
    setStoreFlag("uses_delivery", true);

    const { deliveryId } = await createDeliveryOrder();

    // Nenhuma atribuição — dispatch de outra pessoa é proibido (forbidden_role).
    const dispatch = await api("patch", `/courier/deliveries/${deliveryId}/dispatch`, { token: courier });
    expect(dispatch.status).toBe(403);
    expect(dispatch.json.error.code).toBe("forbidden_role");
  });
});