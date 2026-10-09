import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, manager, waiter, kitchen, FIXTURE } from "./helpers.js";

// Helper: criar pedido fechado com pagamento confirmado
async function createClosedOrder(): Promise<{ orderId: string }> {
  // Abrir pedido
  const orderRes = await api("post", "/orders", {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
  });
  expect(orderRes.status).toBe(201);
  const orderId = orderRes.json.id;

  // Adicionar item
  const itemsRes = await api("post", `/orders/${orderId}/items`, {
    token: waiter,
    body: {
      correlationId: crypto.randomUUID(),
      items: [{ productId: FIXTURE.product, quantity: 2 }], // 2 x 9.50 = 19.00
    },
  });
  expect(itemsRes.status).toBe(201);
  const itemId = itemsRes.json.data[0].id;

  // Cozinha marca como pronto
  await api("patch", `/orders/${orderId}/items/${itemId}`, {
    token: kitchen,
    body: { status: "ready", expectedVersion: 1 },
  });

  // Garçom marca como entregue
  await api("patch", `/orders/${orderId}/items/${itemId}`, {
    token: waiter,
    body: { status: "delivered", expectedVersion: 2 },
  });

  // Registrar pagamento ANTES de fechar (fluxo correto do PDV)
  const paymentRes = await api("put", `/orders/${orderId}/payments`, {
    token: manager,
    body: {
      correlationId: crypto.randomUUID(),
      payments: [{ method: "pix", amount: 19.0, confirmed: true }],
    },
  });
  expect(paymentRes.status).toBe(200);

  // Fechar pedido
  const closeRes = await api("patch", `/orders/${orderId}/close`, {
    token: manager,
    body: { correlationId: crypto.randomUUID() },
  });
  expect(closeRes.status).toBe(200);

  return { orderId };
}

// Helper: criar pedido aberto (não fechado)
async function createOpenOrder(): Promise<{ orderId: string }> {
  const orderRes = await api("post", "/orders", {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
  });
  expect(orderRes.status).toBe(201);
  return { orderId: orderRes.json.id };
}

describe("Settlement iFood (Bloco 5)", () => {
  beforeAll(async () => {
    await seedFixture();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  beforeEach(async () => {
    await resetState();
  });

  describe("POST /settlements", () => {
    it("deve registrar settlement para pedido fechado", async () => {
      const { orderId } = await createClosedOrder();

      const res = await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId: crypto.randomUUID(),
          orderId,
          channel: "ifood",
          grossAmount: 19.0,
          commissionAmount: 3.04, // 16% do iFood
          marketplaceFee: 0.5,
          deliveryFeeSubsidy: 0,
          externalRef: "ord_ifood_123",
          notes: "Settlement de teste",
        },
      });

      expect(res.status).toBe(201);
      expect(res.json.id).toBeDefined();
      expect(res.json.orderId).toBe(orderId);
      expect(res.json.channel).toBe("ifood");
      expect(res.json.grossAmount).toBe(19.0);
      expect(res.json.commissionAmount).toBe(3.04);
      expect(res.json.marketplaceFee).toBe(0.5);
      expect(res.json.payoutAmount).toBe(15.46); // 19.0 - 3.04 - 0.5 - 0
      expect(res.json.payoutStatus).toBe("pending");
      expect(res.json.externalRef).toBe("ord_ifood_123");
      expect(res.json.notes).toBe("Settlement de teste");
    });

    it("deve calcular payoutAmount automaticamente se não informado", async () => {
      const { orderId } = await createClosedOrder();

      const res = await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId: crypto.randomUUID(),
          orderId,
          channel: "ifood",
          grossAmount: 19.0,
          commissionAmount: 3.04,
        },
      });

      expect(res.status).toBe(201);
      expect(res.json.payoutAmount).toBe(15.96); // 19.0 - 3.04 - 0 - 0
    });

    it("deve rejeitar settlement para pedido aberto", async () => {
      const { orderId } = await createOpenOrder();

      const res = await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId: crypto.randomUUID(),
          orderId,
          channel: "ifood",
          grossAmount: 19.0,
          commissionAmount: 3.04,
        },
      });

      expect(res.status).toBe(422);
      expect(res.json.error.code).toBe("settlement_order_not_closed");
    });

    it("deve rejeitar settlement duplicado", async () => {
      const { orderId } = await createClosedOrder();

      // Primeiro settlement
      const res1 = await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId: crypto.randomUUID(),
          orderId,
          channel: "ifood",
          grossAmount: 19.0,
          commissionAmount: 3.04,
        },
      });
      expect(res1.status).toBe(201);

      // Segundo settlement (deve falhar)
      const res2 = await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId: crypto.randomUUID(),
          orderId,
          channel: "ifood",
          grossAmount: 19.0,
          commissionAmount: 3.04,
        },
      });

      expect(res2.status).toBe(409);
      expect(res2.json.error.code).toBe("settlement_already_exists");
    });

    it("deve ser idempotente com mesmo correlationId", async () => {
      const { orderId } = await createClosedOrder();
      const correlationId = crypto.randomUUID();

      const res1 = await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId,
          orderId,
          channel: "ifood",
          grossAmount: 19.0,
          commissionAmount: 3.04,
        },
      });
      expect(res1.status).toBe(201);

      const res2 = await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId, // mesmo correlationId
          orderId,
          channel: "ifood",
          grossAmount: 19.0,
          commissionAmount: 3.04,
        },
      });
      expect(res2.status).toBe(201);
      expect(res2.json.id).toBe(res1.json.id); // mesmo settlement retornado
    });
  });

  describe("PATCH /settlements/:id/settle", () => {
    it("deve marcar settlement como pago", async () => {
      const { orderId } = await createClosedOrder();

      // Registrar settlement
      const createRes = await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId: crypto.randomUUID(),
          orderId,
          channel: "ifood",
          grossAmount: 19.0,
          commissionAmount: 3.04,
        },
      });
      expect(createRes.status).toBe(201);
      const settlementId = createRes.json.id;

      // Marcar como pago
      const settleRes = await api("patch", `/settlements/${settlementId}/settle`, {
        token: manager,
        body: {
          correlationId: crypto.randomUUID(),
          payoutSettledAt: new Date().toISOString(),
        },
      });

      expect(settleRes.status).toBe(200);
      expect(settleRes.json.id).toBe(settlementId);
      expect(settleRes.json.payoutStatus).toBe("paid");
      expect(settleRes.json.payoutSettledAt).toBeDefined();
    });
  });

  describe("GET /settlements", () => {
    it("deve listar settlements com filtros", async () => {
      const { orderId: orderId1 } = await createClosedOrder();
      const { orderId: orderId2 } = await createClosedOrder();

      // Registrar 2 settlements
      await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId: crypto.randomUUID(),
          orderId: orderId1,
          channel: "ifood",
          grossAmount: 19.0,
          commissionAmount: 3.04,
        },
      });

      await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId: crypto.randomUUID(),
          orderId: orderId2,
          channel: "whatsapp",
          grossAmount: 25.0,
          commissionAmount: 0,
        },
      });

      // Listar todos
      const allRes = await api("get", "/settlements", { token: manager });
      expect(allRes.status).toBe(200);
      expect(allRes.json.length).toBe(2);

      // Filtrar por channel
      const ifoodRes = await api("get", "/settlements?channel=ifood", { token: manager });
      expect(ifoodRes.status).toBe(200);
      expect(ifoodRes.json.length).toBe(1);
      expect(ifoodRes.json[0].channel).toBe("ifood");

      // Filtrar por status
      const pendingRes = await api("get", "/settlements?payout_status=pending", { token: manager });
      expect(pendingRes.status).toBe(200);
      expect(pendingRes.json.length).toBe(2);
    });
  });

  describe("GET /settlements/by-order/:orderId", () => {
    it("deve buscar settlement por orderId", async () => {
      const { orderId } = await createClosedOrder();

      const createRes = await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId: crypto.randomUUID(),
          orderId,
          channel: "ifood",
          grossAmount: 19.0,
          commissionAmount: 3.04,
        },
      });
      expect(createRes.status).toBe(201);

      const getRes = await api("get", `/settlements/by-order/${orderId}`, { token: manager });
      expect(getRes.status).toBe(200);
      expect(getRes.json.id).toBe(createRes.json.id);
      expect(getRes.json.orderId).toBe(orderId);
    });

    it("deve retornar null se não houver settlement", async () => {
      const { orderId } = await createClosedOrder();

      const res = await api("get", `/settlements/by-order/${orderId}`, { token: manager });
      expect(res.status).toBe(200);
      expect(res.json).toBeNull();
    });

    it("deve ser acessível para waiter", async () => {
      const { orderId } = await createClosedOrder();

      await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId: crypto.randomUUID(),
          orderId,
          channel: "ifood",
          grossAmount: 19.0,
          commissionAmount: 3.04,
        },
      });

      const res = await api("get", `/settlements/by-order/${orderId}`, { token: waiter });
      expect(res.status).toBe(200);
      expect(res.json).not.toBeNull();
    });
  });

  describe("Relatório com settlement", () => {
    it("deve usar payoutAmount como netTotal quando há settlement", async () => {
      const { orderId } = await createClosedOrder();

      // Registrar settlement
      await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId: crypto.randomUUID(),
          orderId,
          channel: "ifood",
          grossAmount: 19.0,
          commissionAmount: 3.04,
          marketplaceFee: 0.5,
        },
      });

      // Buscar relatório
      const reportRes = await api("get", "/reports/sales", { token: manager });
      expect(reportRes.status).toBe(200);

      const order = reportRes.json.data.find((o: any) => o.orderId === orderId);
      expect(order).toBeDefined();
      expect(order.grossTotal).toBe(19.0);
      expect(order.netTotal).toBe(15.46); // 19.0 - 3.04 - 0.5 - 0
      expect(order.settlement).not.toBeNull();
      expect(order.settlement.channel).toBe("ifood");
      expect(order.settlement.payoutAmount).toBe(15.46);
    });

    it("deve usar cálculo padrão quando não há settlement", async () => {
      const { orderId } = await createClosedOrder();

      const reportRes = await api("get", "/reports/sales", { token: manager });
      expect(reportRes.status).toBe(200);

      const order = reportRes.json.data.find((o: any) => o.orderId === orderId);
      expect(order).toBeDefined();
      expect(order.grossTotal).toBe(19.0);
      expect(order.netTotal).toBe(19.0); // sem settlement, netTotal = grossTotal
      expect(order.settlement).toBeNull();
    });

    it("deve calcular totalNet corretamente no summary", async () => {
      const { orderId: orderId1 } = await createClosedOrder();
      const { orderId: orderId2 } = await createClosedOrder();

      // Pedido 1: com settlement
      await api("post", "/settlements", {
        token: manager,
        body: {
          correlationId: crypto.randomUUID(),
          orderId: orderId1,
          channel: "ifood",
          grossAmount: 19.0,
          commissionAmount: 3.04,
        },
      });

      // Pedido 2: sem settlement
      // (já criado acima)

      const reportRes = await api("get", "/reports/sales", { token: manager });
      expect(reportRes.status).toBe(200);

      const summary = reportRes.json.summary;
      expect(summary.grossRevenue).toBe(38.0); // 19.0 + 19.0
      expect(summary.totalNet).toBe(34.96); // 15.96 (pedido 1) + 19.0 (pedido 2)
      expect(summary.totalNet).not.toBe(summary.grossRevenue);
    });
  });
});
