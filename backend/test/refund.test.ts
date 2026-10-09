import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, manager, cashier, waiter, kitchen, FIXTURE } from "./helpers.js";

// Helper: criar pedido com pagamento confirmado
// Para cash: exige gaveta aberta. Para pix/card: não precisa.
async function createOrderWithPayment(
  method: "cash" | "card" | "pix" = "cash",
  amount: number = 19.0,
  openDrawer: boolean = true
): Promise<{ orderId: string; paymentId: string }> {
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

  // Abrir gaveta se necessário (só para cash confirmado)
  if (method === "cash" && openDrawer) {
    await openCashDrawer();
  }

  // Registrar pagamento ANTES de fechar (fluxo correto do PDV)
  const paymentRes = await api("put", `/orders/${orderId}/payments`, {
    token: manager,
    body: {
      correlationId: crypto.randomUUID(),
      payments: [{ method, amount, confirmed: true }],
    },
  });
  expect(paymentRes.status).toBe(200);
  const paymentId = paymentRes.json.payments[0].id;

  // Fechar pedido
  const closeRes = await api("patch", `/orders/${orderId}/close`, {
    token: manager,
    body: { correlationId: crypto.randomUUID() },
  });
  expect(closeRes.status).toBe(200);

  return { orderId, paymentId };
}

// Helper: criar pedido com pagamento NÃO confirmado (para testar validações)
async function createOrderWithUnconfirmedPayment(): Promise<{ orderId: string; paymentId: string }> {
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
      items: [{ productId: FIXTURE.product, quantity: 2 }],
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

  // Registrar pagamento NÃO confirmado (sem confirmar, não exige gaveta)
  const paymentRes = await api("put", `/orders/${orderId}/payments`, {
    token: manager,
    body: {
      correlationId: crypto.randomUUID(),
      payments: [{ method: "cash", amount: 19.0, confirmed: false }],
    },
  });
  expect(paymentRes.status).toBe(200);
  const paymentId = paymentRes.json.payments[0].id;

  return { orderId, paymentId };
}

// Helper: abrir caixa
async function openCashDrawer(): Promise<void> {
  const res = await api("post", "/cash-drawer/open", {
    token: cashier,
    body: { correlationId: crypto.randomUUID(), openingAmount: 100 },
  });
  expect(res.status).toBe(201);
}

// Helper: listar estornos de um pedido
async function listRefunds(orderId: string): Promise<any[]> {
  const res = await api("get", `/orders/${orderId}/refunds`, { token: manager });
  expect(res.status).toBe(200);
  return res.json;
}

describe("estorno de pagamentos (Bloco 4 ROADMAP-CAIXA.md)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("estorno total em dinheiro com gaveta aberta → refund settled, sangria criada, relatório líquido = 0", async () => {
    const { orderId, paymentId } = await createOrderWithPayment("cash", 19.0, true);

    // Estornar
    const refundRes = await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        amount: 19.0,
        reason: "Cliente desistiu do pedido",
      },
    });
    expect(refundRes.status).toBe(201);
    expect(refundRes.json.status).toBe("settled");
    expect(refundRes.json.amount).toBe(19.0);
    expect(refundRes.json.method).toBe("cash");

    // Verificar sangria criada
    const drawerRes = await api("get", "/cash-drawer/current", { token: cashier });
    expect(drawerRes.status).toBe(200);
    const movements = drawerRes.json.movements;
    const sangria = movements.find((m: any) => m.type === "sangria" && m.amount === 19.0);
    expect(sangria).toBeDefined();
    expect(sangria.refOrderId).toBe(orderId);
    expect(sangria.note).toContain("Estorno");

    // Verificar relatório: líquido = 0 (venda 19 - estorno 19)
    const reportRes = await api("get", "/reports/sales", { token: manager });
    expect(reportRes.status).toBe(200);
    const orderInReport = reportRes.json.data.find((o: any) => o.orderId === orderId);
    expect(orderInReport).toBeDefined();
    expect(orderInReport.grossTotal).toBe(19.0);
    expect(orderInReport.refundsTotal).toBe(19.0);
    expect(orderInReport.netTotal).toBe(0);
  });

  it("estorno parcial em dinheiro → refund settled, sangria parcial, relatório líquido correto", async () => {
    const { orderId, paymentId } = await createOrderWithPayment("cash", 19.0, true);

    // Estornar parcialmente (10.0 de 19.0)
    const refundRes = await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        amount: 10.0,
        reason: "Cliente pagou errado",
      },
    });
    expect(refundRes.status).toBe(201);
    expect(refundRes.json.status).toBe("settled");
    expect(refundRes.json.amount).toBe(10.0);

    // Verificar sangria parcial
    const drawerRes = await api("get", "/cash-drawer/current", { token: cashier });
    expect(drawerRes.status).toBe(200);
    const sangria = drawerRes.json.movements.find((m: any) => m.type === "sangria" && m.amount === 10.0);
    expect(sangria).toBeDefined();

    // Verificar relatório: líquido = 9 (venda 19 - estorno 10)
    const reportRes = await api("get", "/reports/sales", { token: manager });
    expect(reportRes.status).toBe(200);
    const orderInReport = reportRes.json.data.find((o: any) => o.orderId === orderId);
    expect(orderInReport.grossTotal).toBe(19.0);
    expect(orderInReport.refundsTotal).toBe(10.0);
    expect(orderInReport.netTotal).toBe(9.0);
  });

  it("estorno em dinheiro com gaveta fechada → 409 cash_drawer_not_open, refund NÃO criado", async () => {
    // Criar pedido com pagamento confirmado (gaveta aberta)
    const { orderId, paymentId } = await createOrderWithPayment("cash", 19.0, true);

    // Fechar a gaveta
    const drawerRes = await api("get", "/cash-drawer/current", { token: cashier });
    const drawerId = drawerRes.json.id;
    await api("post", "/cash-drawer/close", {
      token: cashier,
      body: {
        correlationId: crypto.randomUUID(),
        countedAmount: 119.0, // 100 (opening) + 19 (venda)
        note: "Fechamento para teste",
      },
    });

    // Tentar estornar
    const refundRes = await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        amount: 19.0,
        reason: "Estorno sem caixa",
      },
    });
    expect(refundRes.status).toBe(409);
    expect(refundRes.json.error.code).toBe("cash_drawer_not_open");

    // Verificar que nenhum refund foi criado
    const refunds = await listRefunds(orderId);
    expect(refunds.length).toBe(0);
  });

  it("estorno em Pix → refund requested, sangria NÃO criada", async () => {
    const { orderId, paymentId } = await createOrderWithPayment("pix", 19.0, false);

    // Estornar
    const refundRes = await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        amount: 19.0,
        reason: "Cliente cancelou",
      },
    });
    expect(refundRes.status).toBe(201);
    expect(refundRes.json.status).toBe("requested"); // Pix não é settled automaticamente
    expect(refundRes.json.settledAt).toBeNull();

    // Verificar que NENHUMA sangria foi criada (Pix não mexe no caixa)
    const drawerRes = await api("get", "/cash-drawer/current", { token: cashier });
    expect(drawerRes.status).toBe(200);
    expect(drawerRes.json).toBeNull(); // Nenhuma gaveta aberta
  });

  it("estorno maior que o pago → 422 refund_exceeds_payment", async () => {
    const { orderId, paymentId } = await createOrderWithPayment("cash", 19.0, true);

    // Tentar estornar mais que o pago
    const refundRes = await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        amount: 25.0, // maior que 19.0
        reason: "Estorno excedente",
      },
    });
    expect(refundRes.status).toBe(422);
    expect(refundRes.json.error.code).toBe("refund_exceeds_payment");
    expect(refundRes.json.error.details.available).toBe(19.0);

    // Verificar que nenhum refund foi criado
    const refunds = await listRefunds(orderId);
    expect(refunds.length).toBe(0);
  });

  it("estorno de pagamento não confirmado → 422 payment_not_confirmed", async () => {
    const { orderId, paymentId } = await createOrderWithUnconfirmedPayment();

    // Tentar estornar
    const refundRes = await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        amount: 19.0,
        reason: "Estorno não confirmado",
      },
    });
    expect(refundRes.status).toBe(422);
    expect(refundRes.json.error.code).toBe("payment_not_confirmed");
  });

  it("dois estornos consecutivos cujo total excede o pagamento → segundo falha com 422", async () => {
    const { orderId, paymentId } = await createOrderWithPayment("cash", 19.0, true);

    // Primeiro estorno: 10.0
    const refund1Res = await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        amount: 10.0,
        reason: "Primeiro estorno",
      },
    });
    expect(refund1Res.status).toBe(201);
    expect(refund1Res.json.amount).toBe(10.0);

    // Segundo estorno: 10.0 (total 20 > 19)
    const refund2Res = await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        amount: 10.0, // 10 + 10 = 20 > 19
        reason: "Segundo estorno",
      },
    });
    expect(refund2Res.status).toBe(422);
    expect(refund2Res.json.error.code).toBe("refund_exceeds_payment");
    expect(refund2Res.json.error.details.available).toBe(9.0); // 19 - 10 = 9

    // Verificar que só o primeiro refund foi criado
    const refunds = await listRefunds(orderId);
    expect(refunds.length).toBe(1);
    expect(refunds[0].amount).toBe(10.0);
  });

  it("idempotência: mesma correlationId não duplica refund", async () => {
    const { orderId, paymentId } = await createOrderWithPayment("cash", 19.0, true);
    const correlationId = crypto.randomUUID();

    // Primeiro request
    const refund1Res = await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: manager,
      body: {
        correlationId,
        amount: 19.0,
        reason: "Estorno idempotente",
      },
    });
    expect(refund1Res.status).toBe(201);

    // Segundo request com mesma correlationId
    const refund2Res = await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: manager,
      body: {
        correlationId,
        amount: 19.0,
        reason: "Estorno idempotente",
      },
    });
    expect(refund2Res.status).toBe(201);
    expect(refund2Res.json.id).toBe(refund1Res.json.id); // mesmo refund

    // Verificar que só um refund foi criado
    const refunds = await listRefunds(orderId);
    expect(refunds.length).toBe(1);
  });

  it("regressão do relatório: vendas + estornos → líquido correto", async () => {
    // Criar 2 pedidos: um estornado parcialmente, outro sem estorno
    const { orderId: order1Id, paymentId: payment1Id } = await createOrderWithPayment("cash", 19.0, true);
    
    // Segundo pedido: 4 itens para totalizar 38.0 (4 x 9.50)
    // Abrir pedido
    const orderRes2 = await api("post", "/orders", {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
    });
    expect(orderRes2.status).toBe(201);
    const order2Id = orderRes2.json.id;
    
    // Adicionar 4 itens (4 x 9.50 = 38.0)
    const itemsRes2 = await api("post", `/orders/${order2Id}/items`, {
      token: waiter,
      body: {
        correlationId: crypto.randomUUID(),
        items: [{ productId: FIXTURE.product, quantity: 4 }],
      },
    });
    expect(itemsRes2.status).toBe(201);
    const itemId2 = itemsRes2.json.data[0].id;
    
    // Cozinha marca como pronto
    await api("patch", `/orders/${order2Id}/items/${itemId2}`, {
      token: kitchen,
      body: { status: "ready", expectedVersion: 1 },
    });
    
    // Garçom marca como entregue
    await api("patch", `/orders/${order2Id}/items/${itemId2}`, {
      token: waiter,
      body: { status: "delivered", expectedVersion: 2 },
    });
    
    // Registrar pagamento (gaveta já está aberta do primeiro pedido)
    const paymentRes2 = await api("put", `/orders/${order2Id}/payments`, {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        payments: [{ method: "cash", amount: 38.0, confirmed: true }],
      },
    });
    expect(paymentRes2.status).toBe(200);
    
    // Fechar pedido
    const closeRes2 = await api("patch", `/orders/${order2Id}/close`, {
      token: manager,
      body: { correlationId: crypto.randomUUID() },
    });
    expect(closeRes2.status).toBe(200);

    // Estornar parcialmente o primeiro
    await api("post", `/orders/${order1Id}/payments/${payment1Id}/refunds`, {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        amount: 5.0,
        reason: "Estorno parcial",
      },
    });

    // Verificar relatório agregado
    const reportRes = await api("get", "/reports/sales", { token: manager });
    expect(reportRes.status).toBe(200);

    const summary = reportRes.json.summary;
    expect(summary.grossRevenue).toBe(57.0); // 19 + 38
    expect(summary.totalRefunds).toBe(5.0);
    expect(summary.netRevenue).toBe(52.0); // 57 - 5
    expect(summary.orderCount).toBe(2);
    expect(summary.avgTicket).toBe(26.0); // 52 / 2

    // Verificar por pedido
    const order1InReport = reportRes.json.data.find((o: any) => o.orderId === order1Id);
    expect(order1InReport.grossTotal).toBe(19.0);
    expect(order1InReport.refundsTotal).toBe(5.0);
    expect(order1InReport.netTotal).toBe(14.0);

    const order2InReport = reportRes.json.data.find((o: any) => o.orderId === order2Id);
    expect(order2InReport.grossTotal).toBe(38.0);
    expect(order2InReport.refundsTotal).toBe(0);
    expect(order2InReport.netTotal).toBe(38.0);
  });

  it("GET /orders/:id/refunds retorna lista de estornos do pedido", async () => {
    const { orderId, paymentId } = await createOrderWithPayment("cash", 19.0, true);

    // Criar 2 estornos
    await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        amount: 5.0,
        reason: "Primeiro estorno",
      },
    });

    await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        amount: 3.0,
        reason: "Segundo estorno",
        notes: "Observação adicional",
      },
    });

    // Listar
    const refunds = await listRefunds(orderId);
    expect(refunds.length).toBe(2);
    expect(refunds[0].amount).toBe(5.0);
    expect(refunds[1].amount).toBe(3.0);
    expect(refunds[1].notes).toBe("Observação adicional");
  });

  it("estorno exige role manager (garçom recebe 403)", async () => {
    const { orderId, paymentId } = await createOrderWithPayment("cash", 19.0, true);

    const refundRes = await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: waiter, // garçom, não manager
      body: {
        correlationId: crypto.randomUUID(),
        amount: 19.0,
        reason: "Estorno não autorizado",
      },
    });
    expect(refundRes.status).toBe(403);
  });

  it("motivo do estorno é obrigatório (min 3 caracteres)", async () => {
    const { orderId, paymentId } = await createOrderWithPayment("cash", 19.0, true);

    const refundRes = await api("post", `/orders/${orderId}/payments/${paymentId}/refunds`, {
      token: manager,
      body: {
        correlationId: crypto.randomUUID(),
        amount: 19.0,
        reason: "ab", // muito curto
      },
    });
    expect(refundRes.status).toBe(400);
  });
});
