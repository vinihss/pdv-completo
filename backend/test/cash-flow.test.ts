import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, cashier, manager, waiter, raw, FIXTURE } from "./helpers.js";
import { dayStart, dayEnd, isValidTz } from "../src/application/cash-flow/day-bounds.js";
import { isUniqueViolationOn } from "../src/infra/db/errors.js";
import { pool } from "../src/infra/db/client.js";

const openDrawer = (correlationId: string, openingAmount: number, note?: string) =>
  api("post", "/cash-drawer/open", { token: cashier, body: { correlationId, openingAmount, note } });
const current = () => api("get", "/cash-drawer/current", { token: cashier });

async function openOrder(): Promise<string> {
  const res = await api("post", "/orders", {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
  });
  const orderId = res.json.id;
  await api("post", `/orders/${orderId}/items`, {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), items: [{ productId: FIXTURE.product, quantity: 2 }] },
  });
  return orderId;
}

describe("fluxo de caixa", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("abre caixa e cria a sessão única (com 403 para garçom)", async () => {
    expect((await current()).json).toBeNull();

    const open = await openDrawer("open-1", 100, "fundo");
    expect(open.status).toBe(201);
    expect(open.json.openingAmount).toBe(100);

    const cur = await current();
    expect(cur.json.expectedCash).toBe(100);
    expect(cur.json.cashSalesTotal).toBe(0);
    expect(cur.json.movements.length).toBe(0);

    const second = await openDrawer("open-2", 50);
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe("cash_drawer_already_open");

    const denied = await api("get", "/cash-drawer/current", { token: waiter });
    expect(denied.status).toBe(403);
  });

  it("aberturas concorrentes: uma só ganha, as outras recebem 409 de domínio (nunca 500)", async () => {
    const racers = await Promise.all([
      openDrawer("race-1", 100),
      openDrawer("race-2", 100),
      openDrawer("race-3", 100),
      openDrawer("race-4", 100),
    ]);

    const created = racers.filter((r) => r.status === 201);
    const rejected = racers.filter((r) => r.status !== 201);
    expect(created).toHaveLength(1);
    for (const r of rejected) {
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe("cash_drawer_already_open");
    }

    const open = await raw.get(
      "SELECT count(*)::int AS n FROM cash_drawer WHERE status = 'open'"
    );
    expect(open.n).toBe(1);
  });

  it("abertura bloqueada no índice: 23505 vira 409 de domínio (nunca 500)", async () => {
    // Mesma corrida, forçada: outra transação ocupa a gaveta e não comita, o
    // pre-check da usecase não enxerga a linha não commitada e o INSERT dela
    // trava no índice parcial até o commit alheio. O 23505 chega embrulhado
    // em DrizzleQueryError — sem desembrulhar o `cause`, a resposta é 500.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `INSERT INTO cash_drawer (id, status, opened_at, opened_by, opening_amount)
         VALUES ('t-blocker', 'open', now() at time zone 'UTC', $1, 10)`,
        [FIXTURE.cashier]
      );

      const pending = openDrawer("blocked-1", 100);
      await new Promise((r) => setTimeout(r, 150));
      await holder.query("COMMIT");

      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe("cash_drawer_already_open");

      const open = await raw.get(`SELECT count(*)::int AS n FROM cash_drawer WHERE status = 'open'`);
      expect(open.n).toBe(1);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
  });

  it("uq_cash_drawer_single_open é a garantia real da sessão única (23505 no índice parcial)", async () => {
    await openDrawer("open-1", 100);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Snapshot "não há caixa aberto" é o estado em que uma checagem
      // anterior passaria: aqui o insert precisa ser o que impede a segunda
      // gaveta, e o erro tem que ser o unique_violation do Postgres.
      const err = await client
        .query(
          `INSERT INTO cash_drawer (id, status, opened_at, opened_by, opening_amount)
           VALUES ('t-race', 'open', now() at time zone 'UTC', $1, 10)`,
          [FIXTURE.cashier]
        )
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err).not.toBeNull();
      expect(isUniqueViolationOn(err, "uq_cash_drawer_single_open")).toBe(true);
      expect((err as { code?: string }).code).toBe("23505");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("duas sangrias concorrentes cujo total excede o disponível → uma falha", async () => {
    await openDrawer("open-race", 100);
    
    // Disparar duas sangrias de R$ 60 concorrentemente
    // O saldo disponível é R$ 100, então apenas uma deve passar
    const [sangria1, sangria2] = await Promise.all([
      api("post", "/cash-drawer/sangria", {
        token: cashier,
        body: { correlationId: "sangria-race-1", amount: 60, category: "sangria_operacional" },
      }),
      api("post", "/cash-drawer/sangria", {
        token: cashier,
        body: { correlationId: "sangria-race-2", amount: 60, category: "sangria_operacional" },
      }),
    ]);

    // Uma deve ter sucesso (200) e a outra deve falhar (409)
    const success = [sangria1, sangria2].filter((r) => r.status === 200);
    const rejected = [sangria1, sangria2].filter((r) => r.status !== 200);
    
    expect(success).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status).toBe(409);
    expect(rejected[0].json.error.code).toBe("cash_withdrawal_exceeds_available");

    // Validar que o saldo final é R$ 40 (não -R$ 20)
    const cur = await current();
    expect(cur.json.expectedCash).toBe(40);
  });

  it("sangria, suprimento e fechamento conferem o esperado", async () => {
    await openDrawer("open-1", 100);

    await api("post", "/cash-drawer/sangria", { token: cashier, body: { correlationId: "s-1", amount: 30, category: "sangria_operacional" } });
    expect((await current()).json.expectedCash).toBe(70);

    await api("post", "/cash-drawer/suprimento", { token: cashier, body: { correlationId: "su-1", amount: 20, category: "suprimento_troco" } });
    expect((await current()).json.expectedCash).toBe(90);

    const over = await api("post", "/cash-drawer/sangria", { token: cashier, body: { correlationId: "s-2", amount: 999, category: "sangria_operacional" } });
    expect(over.status).toBe(409);
    expect(over.json.error.code).toBe("cash_withdrawal_exceeds_available");
    expect(over.json.error.details.available).toBe(90);

    const close = await api("post", "/cash-drawer/close", { token: cashier, body: { correlationId: "c-1", countedAmount: 90 } });
    expect(close.status).toBe(200);
    expect(close.json.closingExpected).toBe(90);
    expect(close.json.closingCounted).toBe(90);
    expect(close.json.closingDifference).toBe(0);

    expect((await current()).json).toBeNull();

    const noOpen = await api("post", "/cash-drawer/sangria", { token: cashier, body: { correlationId: "s-3", amount: 10, category: "sangria_operacional" } });
    expect(noOpen.status).toBe(409);
    expect(noOpen.json.error.code).toBe("cash_drawer_not_open");

    const closeNoOpen = await api("post", "/cash-drawer/close", { token: cashier, body: { correlationId: "c-2", countedAmount: 0 } });
    expect(closeNoOpen.status).toBe(409);
  });

  it("replay de correlationId não duplica a sessão", async () => {
    const a = await openDrawer("open-replay", 10);
    const b = await openDrawer("open-replay", 10);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json.id).toBe(a.json.id);

    const third = await openDrawer("open-3", 5);
    expect(third.status).toBe(409);
  });

  it("bloqueia pagamento em dinheiro confirmado sem caixa aberto (PUT /payments)", async () => {
    const orderId = await openOrder();
    const pay = await api("put", `/orders/${orderId}/payments`, {
      token: waiter,
      body: { payments: [{ method: "cash", amount: 19, received: 20, confirmed: true }] },
    });
    expect(pay.status).toBe(409);
    expect(pay.json.error.code).toBe("cash_drawer_not_open");
  });

  it("bloqueia confirmar dinheiro sem caixa (PATCH /payments/:id)", async () => {
    const orderId = await openOrder();
    const pay = await api("put", `/orders/${orderId}/payments`, {
      token: waiter,
      body: { payments: [{ method: "cash", amount: 19, received: 20, confirmed: false }] },
    });
    expect(pay.status).toBe(200);
    const paymentId = pay.json.payments[0].id;

    const confirm = await api("patch", `/orders/${orderId}/payments/${paymentId}`, { token: waiter });
    expect(confirm.status).toBe(409);
    expect(confirm.json.error.code).toBe("cash_drawer_not_open");
  });

  it("com caixa aberto, dinheiro entra no esperado ao vivo", async () => {
    await openDrawer("open-1", 100);
    const orderId = await openOrder();
    await api("put", `/orders/${orderId}/payments`, {
      token: waiter,
      body: { payments: [{ method: "cash", amount: 19, received: 20, confirmed: true }] },
    });
    const cur = await current();
    expect(cur.json.expectedCash).toBe(119);
    expect(cur.json.cashSalesTotal).toBe(19);
    expect(cur.json.cashSalesCount).toBe(1);
  });

  it("estorno: cancelar comanda paga em dinheiro gera sangria automática", async () => {
    await openDrawer("open-1", 100);
    const orderId = await openOrder();
    await api("put", `/orders/${orderId}/payments`, {
      token: waiter,
      body: { payments: [{ method: "cash", amount: 19, received: 20, confirmed: true }] },
    });
    expect((await current()).json.expectedCash).toBe(119);

    const cancel = await api("patch", `/orders/${orderId}/cancel`, {
      token: manager,
      body: { correlationId: "cancel-x", reason: "cliente desistiu" },
    });
    expect(cancel.status).toBe(200);

    const cur = await current();
    expect(cur.json.expectedCash).toBe(100);
    expect(cur.json.movements.length).toBe(1);
    const [m] = cur.json.movements;
    expect(m.type).toBe("sangria");
    expect(m.amount).toBe(19);
    expect(m.refOrderId).toBe(orderId);
    expect(m.refOrderLabel).toBe("Mesa 1");
    expect(m.note).toContain("Estorno");
  });

  it("bloqueia estorno quando o caixa já está fechado", async () => {
    await openDrawer("open-1", 100);
    const orderId = await openOrder();
    await api("put", `/orders/${orderId}/payments`, {
      token: waiter,
      body: { payments: [{ method: "cash", amount: 19, received: 20, confirmed: true }] },
    });
    await api("post", "/cash-drawer/close", { token: cashier, body: { correlationId: "c-1", countedAmount: 119 } });

    const cancel = await api("patch", `/orders/${orderId}/cancel`, {
      token: manager,
      body: { correlationId: "cancel-x", reason: "devolução após fechamento" },
    });
    expect(cancel.status).toBe(409);
    expect(cancel.json.error.code).toBe("cash_drawer_not_open");
  });

  it("summary agrega as sessões por período", async () => {
    await openDrawer("open-1", 50);
    await api("post", "/cash-drawer/close", { token: cashier, body: { correlationId: "c-1", countedAmount: 50 } });
    await openDrawer("open-2", 200);
    await api("post", "/cash-drawer/close", { 
      token: cashier, 
      body: { 
        correlationId: "c-2", 
        countedAmount: 210,
        justification: "Diferença de troco"
      } 
    });

    const s = await api("get", "/cash-drawer/summary?from=2000-01-01&to=2100-01-01", { token: manager });
    expect(s.status).toBe(200);
    expect(s.json.sessions.length).toBe(2);
    expect(s.json.totalExpected).toBe(250);
    expect(s.json.totalCounted).toBe(260);
    expect(s.json.totalDifference).toBe(10);
  });

  it("summary com sessão aberta: totais de conferência só das fechadas + openCount/openExpected", async () => {
    await openDrawer("open-1", 50);
    await api("post", "/cash-drawer/close", { 
      token: cashier, 
      body: { 
        correlationId: "c-1", 
        countedAmount: 54,
        justification: "Diferença de troco"
      } 
    });
    await openDrawer("open-2", 100);
    await api("put", `/orders/${await openOrder()}/payments`, {
      token: waiter,
      body: { payments: [{ method: "cash", amount: 19, received: 20, confirmed: true }] },
    });

    const s = await api("get", "/cash-drawer/summary?from=2000-01-01&to=2100-01-01", { token: manager });
    expect(s.status).toBe(200);
    expect(s.json.sessions.length).toBe(2);
    expect(s.json.openCount).toBe(1);
    expect(s.json.openExpected).toBe(119);
    expect(s.json.totalExpected).toBe(50);
    expect(s.json.totalCounted).toBe(54);
    expect(s.json.totalDifference).toBe(4);
    expect(s.json.totalSales).toBe(19); // totalSales soma só vendas em dinheiro
    expect(s.json.totalOpening).toBe(150);
  });

  it("fechamento registra observação de conferência (closingNote)", async () => {
    await openDrawer("open-1", 100);
    const close = await api("post", "/cash-drawer/close", {
      token: cashier,
      body: { 
        correlationId: "c-note", 
        countedAmount: 98, 
        note: "Emprestados R$ 2 para troco",
        justification: "Pequena diferença de troco"
      },
    });
    expect(close.status).toBe(200);
    expect(close.json.closingNote).toBe("Emprestados R$ 2 para troco");
    expect(close.json.closingDifference).toBe(-2);
    expect(close.json.closingJustification).toBe("Pequena diferença de troco");

    const detail = await api("get", `/cash-drawer/${close.json.id}`, { token: manager });
    expect(detail.status).toBe(200);
    expect(detail.json.closingNote).toBe("Emprestados R$ 2 para troco");
    expect(detail.json.closingJustification).toBe("Pequena diferença de troco");
  });

  it("summary: tz inválido responde 400", async () => {
    const s = await api("get", "/cash-drawer/summary?from=2026-01-01&to=2026-01-02&tz=bogus", { token: manager });
    expect(s.status).toBe(400);
    expect(s.json.error.code).toBe("validation_failed");
  });

  it("fechamento sem denominações e sem diferença → sucesso (configuração default tolerância=0)", async () => {
    await openDrawer("open-1", 100);
    const close = await api("post", "/cash-drawer/close", {
      token: cashier,
      body: { correlationId: "c-no-denom", countedAmount: 100 },
    });
    expect(close.status).toBe(200);
    expect(close.json.closingExpected).toBe(100);
    expect(close.json.closingCounted).toBe(100);
    expect(close.json.closingDifference).toBe(0);
    expect(close.json.closingDenominations).toEqual([]);
    expect(close.json.closingJustification).toBeNull();
    expect(close.json.closingApprovedBy).toBeNull();
  });

  it("fechamento com denominações que não batem com countedAmount → 422 closing_denominations_mismatch", async () => {
    await openDrawer("open-1", 100);
    const close = await api("post", "/cash-drawer/close", {
      token: cashier,
      body: {
        correlationId: "c-denom-mismatch",
        countedAmount: 100,
        denominations: [
          { denomination: 50, quantity: 1 }, // 50*1 = 50
          { denomination: 20, quantity: 1 }, // 20*1 = 20
          // total = 70, não 100
        ],
      },
    });
    expect(close.status).toBe(422);
    expect(close.json.error.code).toBe("closing_denominations_mismatch");
    expect(close.json.error.details.expected).toBe(100);
    expect(close.json.error.details.counted).toBe(70);
  });

  it("fechamento com denominações corretas → sucesso", async () => {
    await openDrawer("open-1", 100);
    const close = await api("post", "/cash-drawer/close", {
      token: cashier,
      body: {
        correlationId: "c-denom-ok",
        countedAmount: 100,
        denominations: [
          { denomination: 50, quantity: 1 }, // 50*1 = 50
          { denomination: 20, quantity: 2 }, // 20*2 = 40
          { denomination: 10, quantity: 1 }, // 10*1 = 10
          // total = 100
        ],
      },
    });
    expect(close.status).toBe(200);
    expect(close.json.closingDenominations).toHaveLength(3);
    expect(close.json.closingDenominations[0]).toEqual({ denomination: 50, quantity: 1 });
  });

  it("fechamento com diferença > tolerância sem justificativa → 422 closing_tolerance_exceeded", async () => {
    // Atualizar tolerância para 5
    await raw.exec("UPDATE store_settings SET cash_closing_tolerance = 5 WHERE id = 'singleton'");

    await openDrawer("open-1", 100);
    // Diferença de 10 (esperado 100, contado 90) > tolerância 5
    const close = await api("post", "/cash-drawer/close", {
      token: cashier,
      body: { correlationId: "c-no-justif", countedAmount: 90 },
    });
    expect(close.status).toBe(422);
    expect(close.json.error.code).toBe("closing_tolerance_exceeded");
    expect(close.json.error.details.difference).toBe(-10);
    expect(close.json.error.details.tolerance).toBe(5);
  });

  it("fechamento com diferença > tolerância com justificativa → sucesso", async () => {
    // Configurar tolerância e requireApprovalAbove para este teste
    await raw.exec("UPDATE store_settings SET cash_closing_tolerance = 5, cash_closing_require_approval_above = 100 WHERE id = 'singleton'");
    
    await openDrawer("open-1", 100);
    // Diferença de 10 (esperado 100, contado 90) > tolerância 5, mas < requireApprovalAbove
    const close = await api("post", "/cash-drawer/close", {
      token: cashier,
      body: {
        correlationId: "c-with-justif",
        countedAmount: 90,
        justification: "Troco errado para cliente",
      },
    });
    expect(close.status).toBe(200);
    expect(close.json.closingJustification).toBe("Troco errado para cliente");
    expect(close.json.closingDifference).toBe(-10);
  });

  it("fechamento com diferença > requireApprovalAbove sem aprovador → 422 closing_approval_required", async () => {
    // Configurar ambos os valores em um único UPDATE
    await raw.exec(
      "UPDATE store_settings SET cash_closing_tolerance = 0, cash_closing_require_approval_above = 8 WHERE id = 'singleton'"
    );

    await openDrawer("open-1", 100);
    // Diferença de 10 (esperado 100, contado 90) > requireApprovalAbove 8
    const close = await api("post", "/cash-drawer/close", {
      token: cashier,
      body: {
        correlationId: "c-no-approval",
        countedAmount: 90,
        justification: "Alguns trocados",
      },
    });
    expect(close.status).toBe(422);
    expect(close.json.error.code).toBe("closing_approval_required");
    expect(close.json.error.details.difference).toBe(-10);
    expect(close.json.error.details.threshold).toBe(8);
  });

  it("fechamento com diferença > requireApprovalAbove com aprovador → sucesso", async () => {
    // requireApprovalAbove já está 8 do teste anterior
    await openDrawer("open-1", 100);
    // Diferença de 10 > requireApprovalAbove 8
    const close = await api("post", "/cash-drawer/close", {
      token: cashier,
      body: {
        correlationId: "c-with-approval",
        countedAmount: 90,
        justification: "Troco incorreto",
        approvedBy: FIXTURE.manager,
      },
    });
    expect(close.status).toBe(200);
    expect(close.json.closingApprovedBy).toBe(FIXTURE.manager);
    expect(close.json.closingJustification).toBe("Troco incorreto");
  });

  it("idempotência: PUT /orders/:id/payments com mesmo correlationId não re-executa", async () => {
    await openDrawer("open-1", 100);
    const orderId = await openOrder();
    
    // Primeira requisição com correlationId 'pay-1'
    const first = await api("put", `/orders/${orderId}/payments`, {
      token: waiter,
      body: { correlationId: "pay-1", payments: [{ method: "cash", amount: 19, received: 20, confirmed: true }] },
    });
    expect(first.status).toBe(200);
    expect(first.json.payments).toHaveLength(1);
    
    // Segunda requisição com mesmo correlationId
    const second = await api("put", `/orders/${orderId}/payments`, {
      token: waiter,
      body: { correlationId: "pay-1", payments: [{ method: "cash", amount: 19, received: 20, confirmed: true }] },
    });
    expect(second.status).toBe(200);
    expect(second.json.payments).toHaveLength(1);
    
    // Validar que apenas 1 linha de pagamento existe (não duplicou)
    const payments = await raw.all(
      `SELECT id FROM order_payment WHERE order_id = $1`,
      [orderId]
    );
    expect(payments).toHaveLength(1);
    
    // Validar que o saldo do caixa é consistente (não duplicou a venda)
    const cur = await current();
    expect(cur.json.expectedCash).toBe(119); // 100 + 19
    expect(cur.json.cashSalesTotal).toBe(19);
    expect(cur.json.cashSalesCount).toBe(1);
  });

  it("idempotência: PATCH /orders/:id/payments/:paymentId com mesmo correlationId não re-executa", async () => {
    await openDrawer("open-1", 100);
    const orderId = await openOrder();
    
    // Criar pagamento não confirmado
    const pay = await api("put", `/orders/${orderId}/payments`, {
      token: waiter,
      body: { correlationId: "pay-1", payments: [{ method: "cash", amount: 19, received: 20, confirmed: false }] },
    });
    expect(pay.status).toBe(200);
    const paymentId = pay.json.payments[0].id;
    
    // Confirmar pagamento com correlationId
    const first = await api("patch", `/orders/${orderId}/payments/${paymentId}`, {
      token: waiter,
      body: { correlationId: "confirm-1" },
    });
    expect(first.status).toBe(200);
    expect(first.json.confirmed).toBe(true);
    
    // Tentar confirmar novamente com mesmo correlationId
    const second = await api("patch", `/orders/${orderId}/payments/${paymentId}`, {
      token: waiter,
      body: { correlationId: "confirm-1" },
    });
    expect(second.status).toBe(200);
    expect(second.json.confirmed).toBe(true);
    
    // Validar que o caixa registrou apenas uma vez
    const cur = await current();
    expect(cur.json.cashSalesCount).toBe(1);
    expect(cur.json.cashSalesTotal).toBe(19);
  });

  it("idempotência: DELETE /orders/:id/payments/:paymentId com mesmo correlationId não re-executa", async () => {
    await openDrawer("open-1", 100);
    const orderId = await openOrder();
    
    // Criar pagamento não confirmado
    const pay = await api("put", `/orders/${orderId}/payments`, {
      token: waiter,
      body: { correlationId: "pay-1", payments: [{ method: "cash", amount: 19, confirmed: false }] },
    });
    expect(pay.status).toBe(200);
    const paymentId = pay.json.payments[0].id;
    
    // Deletar pagamento com correlationId
    const first = await api("delete", `/orders/${orderId}/payments/${paymentId}`, {
      token: waiter,
      body: { correlationId: "del-1" },
    });
    expect(first.status).toBe(204);
    
    // Tentar deletar novamente com mesmo correlationId (deve retornar 204 novamente)
    const second = await api("delete", `/orders/${orderId}/payments/${paymentId}`, {
      token: waiter,
      body: { correlationId: "del-1" },
    });
    expect(second.status).toBe(204);
    
    // Validar que não há pagamentos
    const payments = await raw.all(
      `SELECT id FROM order_payment WHERE order_id = $1`,
      [orderId]
    );
    expect(payments).toHaveLength(0);
  });

  it("day-bounds: dia local desloca do UTC conforme o offset", () => {
    expect(dayStart("2026-09-19", "-03:00")).toBe("2026-09-19T03:00:00.000Z");
    expect(dayEnd("2026-09-19", "-03:00")).toBe("2026-09-20T02:59:59.999Z");
    expect(dayStart("2026-09-19", "+05:30")).toBe("2026-09-18T18:30:00.000Z");
    expect(dayStart("2026-09-19")).toBe("2026-09-19T00:00:00.000Z");
    expect(dayEnd("2026-09-19")).toBe("2026-09-19T23:59:59.999Z");
    expect(dayStart("2026-09-19T10:00:00.000Z", "-03:00")).toBe("2026-09-19T10:00:00.000Z");
    expect(isValidTz("-03:00")).toBe(true);
    expect(isValidTz("+14:00")).toBe(false);
    expect(isValidTz("gibberish")).toBe(false);
    expect(isValidTz(undefined)).toBe(true);
  });
});
