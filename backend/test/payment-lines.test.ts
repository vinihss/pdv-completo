/**
 * Linhas de pagamento já confirmadas: o PUT /orders/:id/payments não pode
 * apagar dinheiro que a gaveta já contou.
 *
 * O caixa não tem saldo próprio — `GET /cash-drawer/*` deriva o esperado de
 * `order_payment` com `method='cash' AND confirmed` na janela da sessão
 * (cash-flow.usecases.ts → cashPaymentsBetween). Então uma linha confirmada
 * apagada por um reenvio do PUT some do relatório *retroativamente*: sem
 * sangra, sem movimento de estorno e sem rastro em auditoria, com o dinheiro
 * já no bolso do garçom.
 *
 * A suíte fixa os três caminhos de `upsertPaymentLines`:
 *   1. reenvio da mesma linha confirmada → PRESERVA (id/confirmed_at/confirmed_by)
 *   2. reenvio sem a linha confirmada → RECUSA (invalid_transition), linha fica
 *   3. linha não confirmada → reescrita livremente (PUT segue funcionando)
 * e o mesmo contrato no caminho legado `PATCH /orders/:id/payment`.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, cashier, waiter, FIXTURE, raw } from "./helpers.js";

// Chopp 300ml = R$ 9,50 (fixture). 2 itens = 19,00; 4 itens = 38,00.
const ONE = 19;
const TWO = 38;

const openDrawer = (correlationId: string, openingAmount: number) =>
  api("post", "/cash-drawer/open", { token: cashier, body: { correlationId, openingAmount } });
const current = () => api("get", "/cash-drawer/current", { token: cashier });

/** Comanda com `quantity` itens do fixture (total = quantity × 9,50). */
async function openOrder(quantity = 2): Promise<string> {
  const res = await api("post", "/orders", {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
  });
  const orderId = res.json.id;
  await api("post", `/orders/${orderId}/items`, {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), items: [{ productId: FIXTURE.product, quantity }] },
  });
  return orderId;
}

const put = (orderId: string, payments: unknown[]) =>
  api("put", `/orders/${orderId}/payments`, { token: waiter, body: { payments } });

/** Linhas de pagamento no banco — o teste de recusa confere aqui, não só no status HTTP. */
async function paymentRows(orderId: string) {
  return raw.all(
    `SELECT id, method, amount, received, change, confirmed, confirmed_at, confirmed_by
       FROM order_payment WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId]
  );
}

/** Último `order.payment_changed` publicado num room, com o payload decodificado. */
async function lastPaymentEvent(room: string) {
  const row = await raw.get(
    `SELECT payload FROM outbox_event
      WHERE room = $1 AND event_type = 'order.payment_changed'
      ORDER BY seq DESC LIMIT 1`,
    [room]
  );
  return row ? JSON.parse(row.payload) : null;
}

async function lastAudit(orderId: string) {
  const row = await raw.get(
    `SELECT details FROM audit_log WHERE order_id = $1 AND action = 'payment_registered'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [orderId]
  );
  return row ? JSON.parse(row.details) : null;
}

describe("linha de pagamento confirmada não pode sumir num reenvio do PUT", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  // ---------- caminho 1: preservar ----------
  it("reenvio da mesma linha cash confirmada preserva id, confirmed_at e confirmed_by", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder();

    const first = await put(orderId, [{ method: "cash", amount: ONE, received: ONE, confirmed: true }]);
    expect(first.status).toBe(200);
    const [before] = await paymentRows(orderId);
    expect(before.confirmed).toBe(true);

    // Mesmo método, mesmo valor: o PUT é a repetição da mesma operação, e a
    // linha confirmada é reaproveitada em vez de apagada e reinserida.
    const again = await put(orderId, [{ method: "cash", amount: ONE, received: ONE, confirmed: true }]);
    expect(again.status).toBe(200);

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].confirmed_at).toBe(before.confirmed_at);
    expect(rows[0].confirmed_by).toBe(before.confirmed_by);
    // E o dinheiro segue na gaveta.
    expect((await current()).json.expectedCash).toBe(100 + ONE);

    // Auditoria precisa dizer que a linha foi reaproveitada, não "criada".
    const audit = await lastAudit(orderId);
    expect(audit.reused).toEqual([before.id]);
    expect(audit.created).toEqual([]);
  });

  it("preserva a linha confirmada e aceita uma linha nova ao lado (soma = total)", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder(); // 2 itens = R$ 19,00
    const first = await put(orderId, [{ method: "cash", amount: ONE, confirmed: true }]);
    expect(first.status).toBe(200);
    const [cashBefore] = await paymentRows(orderId);

    // Mais 2 itens: total R$ 38,00. Cliente paga metade em dinheiro (já
    // confirmado e na gaveta) e o resto no cartão, ainda por receber.
    await api("post", `/orders/${orderId}/items`, {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), items: [{ productId: FIXTURE.product, quantity: 2 }] },
    });
    const split = await put(orderId, [
      { method: "cash", amount: ONE, confirmed: true },
      { method: "card", amount: ONE, confirmed: false },
    ]);
    expect(split.status).toBe(200);

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(2);
    const cash = rows.find((r) => r.method === "cash")!;
    const card = rows.find((r) => r.method === "card")!;
    expect(cash.id).toBe(cashBefore.id);
    expect(cash.confirmed_at).toBe(cashBefore.confirmed_at);
    expect(cash.confirmed).toBe(true);
    expect(card.confirmed).toBe(false);
    expect(card.confirmed_at).toBeNull();

    // `reused`/`created` separam as duas coisas, e o evento da gaveta carrega o
    // conjunto final (preservada + nova), não só o que o request mandou.
    const audit = await lastAudit(orderId);
    expect(audit.reused).toEqual([cash.id]);
    expect(audit.created).toEqual([card.id]);
    for (const room of ["cash-drawer", "kitchen-display"]) {
      const ev = await lastPaymentEvent(room);
      expect(ev.payments).toHaveLength(2);
      expect(ev.payments.map((p: any) => p.method).sort()).toEqual(["card", "cash"]);
    }
    expect((await current()).json.expectedCash).toBe(100 + ONE);
  });

  it("preservar atualiza só o troco quando o dinheiro entregue muda", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder();
    const first = await put(orderId, [{ method: "cash", amount: ONE, received: ONE, confirmed: true }]);
    expect(first.status).toBe(200);
    const [before] = await paymentRows(orderId);
    expect(before.change).toBe(0);

    const again = await put(orderId, [{ method: "cash", amount: ONE, received: 20, confirmed: true }]);
    expect(again.status).toBe(200);

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].received).toBe(20);
    expect(rows[0].change).toBe(1);
    // A confirmação é do dinheiro original: `confirmed_at`/`confirmed_by` não
    // podem ser regrampados por um ajuste de troco.
    expect(rows[0].confirmed_at).toBe(before.confirmed_at);
    expect(rows[0].confirmed_by).toBe(before.confirmed_by);
  });

  it("confirmed:false no reenvio não desconfirma a linha preservada", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder();
    await put(orderId, [{ method: "cash", amount: ONE, confirmed: true }]);
    const [before] = await paymentRows(orderId);

    // O request manda "não confirmado", mas o dinheiro já está na gaveta:
    // desconfirmar aqui seria a mesma sangra do caminho 2 por outro nome.
    const again = await put(orderId, [{ method: "cash", amount: ONE, confirmed: false }]);
    expect(again.status).toBe(200);
    const rows = await paymentRows(orderId);
    expect(rows[0].confirmed).toBe(true);
    expect(rows[0].confirmed_at).toBe(before.confirmed_at);
    expect((await current()).json.expectedCash).toBe(100 + ONE);
  });

  // ---------- caminho 2: recusar ----------
  it("PUT sem a linha cash confirmada é recusado e a linha continua na tabela", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder();
    const first = await put(orderId, [{ method: "cash", amount: ONE, confirmed: true }]);
    expect(first.status).toBe(200);
    const [before] = await paymentRows(orderId);

    const attempt = await put(orderId, [{ method: "card", amount: ONE, confirmed: false }]);
    expect(attempt.status).toBe(400);
    expect(attempt.json.error.code).toBe("invalid_transition");
    expect(attempt.json.error.message).toContain("estorno");
    expect(attempt.json.error.message).toContain("19.00");

    // O erro não pode ter deixado rastro: a linha confirmada está intacta…
    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].method).toBe("cash");
    expect(rows[0].confirmed).toBe(true);
    // …e a gaveta continua contando o dinheiro.
    const drawer = await current();
    expect(drawer.json.expectedCash).toBe(100 + ONE);
    expect(drawer.json.cashSalesTotal).toBe(ONE);
    expect(drawer.json.cashSalesCount).toBe(1);
  });

  it("recusa vale para cartão confirmado também (não só cash)", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder();
    const paid = await put(orderId, [{ method: "card", amount: ONE, confirmed: true }]);
    expect(paid.status).toBe(200);
    const [before] = await paymentRows(orderId);

    // O cartão confirmado sai da lista: o relatório de vendas por forma
    // (report.usecases.ts) perderia R$ 19,00 em silêncio.
    const dropCard = await put(orderId, [{ method: "pix", amount: ONE, confirmed: true }]);
    expect(dropCard.status).toBe(400);
    expect(dropCard.json.error.code).toBe("invalid_transition");
    expect(dropCard.json.error.message).toContain("Cartão");

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].method).toBe("card");
    expect(rows[0].confirmed).toBe(true);
  });

  it("recusa vale para pix confirmado também (não só cash)", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder();
    const paid = await put(orderId, [{ method: "pix", amount: ONE, confirmed: true }]);
    expect(paid.status).toBe(200);
    const [before] = await paymentRows(orderId);

    const dropPix = await put(orderId, [{ method: "card", amount: ONE, confirmed: true }]);
    expect(dropPix.status).toBe(400);
    expect(dropPix.json.error.code).toBe("invalid_transition");
    expect(dropPix.json.error.message).toContain("Pix");

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].method).toBe("pix");
    expect(rows[0].confirmed).toBe(true);
  });

  it("recusa também quando o valor da linha confirmada muda (mesmo método)", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder(); // total R$ 19,00
    const paid = await put(orderId, [{ method: "cash", amount: ONE, confirmed: true }]);
    expect(paid.status).toBe(200);
    const [before] = await paymentRows(orderId);

    // Mais 2 itens: total R$ 38,00. Trocar os R$ 19,00 confirmados por R$ 38,00
    // é a forma "limpa" de estornar — apaga a linha e o dinheiro sai da gaveta
    // sem nenhum movimento de estorno.
    await api("post", `/orders/${orderId}/items`, {
      token: waiter,
      body: { correlationId: crypto.randomUUID(), items: [{ productId: FIXTURE.product, quantity: 2 }] },
    });
    const attempt = await put(orderId, [{ method: "cash", amount: TWO, confirmed: true }]);
    expect(attempt.status).toBe(400);
    expect(attempt.json.error.code).toBe("invalid_transition");

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].amount).toBe(ONE);
    expect((await current()).json.expectedCash).toBe(100 + ONE);
  });

  // ---------- caminho 3: não confirmada continua reescrevível ----------
  it("linha não confirmada continua sendo substituída normalmente", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder();

    const intention = await put(orderId, [{ method: "cash", amount: ONE, received: 20, confirmed: false }]);
    expect(intention.status).toBe(200);
    const [before] = await paymentRows(orderId);
    expect(before.confirmed).toBe(false);

    // Sem dinheiro confirmado em jogo, o PUT continua substituindo o conjunto.
    const swap = await put(orderId, [{ method: "card", amount: ONE, confirmed: false }]);
    expect(swap.status).toBe(200);

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe("card");
    expect(rows[0].id).not.toBe(before.id);

    const audit = await lastAudit(orderId);
    expect(audit.reused).toEqual([]);
    expect(audit.created).toEqual([rows[0].id]);
    // Nada de dinheiro: a gaveta não viu nada.
    expect((await current()).json.expectedCash).toBe(100);
  });

  it("não confirmada → confirmada pelo próprio PUT continua funcionando", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder();
    const intention = await put(orderId, [{ method: "cash", amount: ONE, received: 20, confirmed: false }]);
    expect(intention.status).toBe(200);

    const confirmed = await put(orderId, [{ method: "cash", amount: ONE, received: 20, confirmed: true }]);
    expect(confirmed.status).toBe(200);
    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].confirmed).toBe(true);
    expect((await current()).json.expectedCash).toBe(100 + ONE);
  });
});

/**
 * Regressão do P0: o dinheiro da gaveta não pode sumir por uma edição de
 * pagamento. Este é o cenário exato do bug — dinheiro confirmado entra, e um
 * reenvio do PUT com lista diferente apaga a linha que a gaveta contava.
 *
 * Antes da correção: o PUT respondia 200, a linha confirmada era apagada e o
 * esperado da gaveta voltava ao valor do fundo (R$ 19,00 evaporavam da
 * conferência, sem sangra e sem auditoria). Depois: 400 invalid_transition e o
 * dinheiro continua lá.
 */
describe("regressão P0: PUT não pode fazer a gaveta perder dinheiro", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("cash confirmado + reenvio com outra forma: o dinheiro continua na gaveta", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder();

    // Garçom recebe R$ 19,00 em dinheiro e confirma.
    const pay = await put(orderId, [{ method: "cash", amount: ONE, received: 20, confirmed: true }]);
    expect(pay.status).toBe(200);
    const drawer = await current();
    expect(drawer.json.expectedCash).toBe(100 + ONE);
    expect(drawer.json.cashSalesTotal).toBe(ONE);

    // A tela de pagamento reenvia a lista sem o dinheiro (intenção de cartão,
    // por exemplo). A linha confirmada NÃO pode ser apagada.
    const edit = await put(orderId, [{ method: "card", amount: ONE, confirmed: false }]);
    expect(edit.status).toBe(400);
    expect(edit.json.error.code).toBe("invalid_transition");

    // O dinheiro segue na conferência…
    const after = await current();
    expect(after.json.expectedCash).toBe(100 + ONE);
    expect(after.json.cashSalesTotal).toBe(ONE);
    expect(after.json.cashSalesCount).toBe(1);

    // …e a linha segue no banco, com a confirmação original.
    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe("cash");
    expect(rows[0].amount).toBe(ONE);
    expect(rows[0].confirmed).toBe(true);
  });

  it("split confirmado + reenvio parcial: a parte de dinheiro não evapora", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder(4); // total R$ 38,00

    // Cliente paga R$ 19,00 em dinheiro e R$ 19,00 no cartão, ambos confirmados.
    const split = await put(orderId, [
      { method: "cash", amount: ONE, confirmed: true },
      { method: "card", amount: ONE, confirmed: true },
    ]);
    expect(split.status).toBe(200);
    const [cashBefore] = (await paymentRows(orderId)).filter((r) => r.method === "cash");
    expect((await current()).json.expectedCash).toBe(100 + ONE);

    // Reenvio lista só o cartão (o caixa "corrige" o pagamento): o dinheiro já
    // contado não pode desaparecer. A guarda roda antes da conferência da soma,
    // então a resposta é "exige estorno" — e não o 409 de "soma não confere",
    // que mandaria o usuário corrigir um número que já estava certo.
    const edit = await put(orderId, [{ method: "card", amount: ONE, confirmed: true }]);
    expect(edit.status).toBe(400);
    expect(edit.json.error.code).toBe("invalid_transition");
    expect(edit.json.error.message).not.toContain("soma");

    expect((await current()).json.expectedCash).toBe(100 + ONE);
    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(2);
    const cash = rows.find((r) => r.method === "cash")!;
    expect(cash.id).toBe(cashBefore.id);
    expect(cash.confirmed).toBe(true);
  });
});

/** O mesmo contrato no caminho legado, que monta uma linha de 100% do total. */
describe("caminho legado PATCH /orders/:id/payment", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  const patch = (orderId: string, body: unknown) =>
    api("patch", `/orders/${orderId}/payment`, { token: waiter, body });

  it("reenvia a mesma linha confirmada preservando id e confirmed_at", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder();

    const first = await patch(orderId, { paymentMethod: "cash", confirmed: true });
    expect(first.status).toBe(200);
    const [before] = await paymentRows(orderId);

    const again = await patch(orderId, { paymentMethod: "cash", confirmed: true });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(before.id);

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].confirmed_at).toBe(before.confirmed_at);
    expect((await current()).json.expectedCash).toBe(100 + ONE);

    const audit = await lastAudit(orderId);
    expect(audit.reused).toEqual([before.id]);
    expect(audit.created).toEqual([]);
  });

  it("trocar a forma de pagamento depois de confirmado é recusado", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder();

    const paid = await patch(orderId, { paymentMethod: "cash", confirmed: true });
    expect(paid.status).toBe(200);
    const [before] = await paymentRows(orderId);

    const swap = await patch(orderId, { paymentMethod: "card", confirmed: true });
    expect(swap.status).toBe(400);
    expect(swap.json.error.code).toBe("invalid_transition");

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].method).toBe("cash");
    expect((await current()).json.expectedCash).toBe(100 + ONE);
  });

  it("intenção não confirmada (self-service) continua substituível", async () => {
    await openDrawer("d-1", 100);
    const orderId = await openOrder();

    const intention = await patch(orderId, { paymentMethod: "pix", confirmed: false });
    expect(intention.status).toBe(200);
    const [before] = await paymentRows(orderId);
    expect(before.confirmed).toBe(false);

    // Na entrega o dinheiro é recebido: a intenção sai, a confirmação entra.
    const received = await patch(orderId, { paymentMethod: "pix", confirmed: true });
    expect(received.status).toBe(200);
    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].confirmed).toBe(true);
    expect(rows[0].id).not.toBe(before.id);
  });
});
