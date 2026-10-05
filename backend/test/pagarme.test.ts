import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { api, seedFixture, resetState, closeTestApp, cashier, manager, waiter, FIXTURE, raw } from "./helpers.js";
import { db } from "../src/infra/db/client.js";
import { and, eq } from "drizzle-orm";
import { payments, paymentEvents, paymentRefunds, orderPayments, storeSettings, auditLog } from "../src/infra/db/schema.js";
import {
  canTransition,
  isTerminal,
  refundableAmount,
  isFullyRefunded,
  assertTransition,
  type PaymentStatus,
} from "../src/domain/payment.js";
import { mapStatus, mapPaymentMethod, toCents, fromCents, buildCreateOrderBody, mapOrderToCharge } from "../src/integrations/pagarme/mapper.js";
import { verifyWebhookSignature } from "../src/integrations/pagarme/webhook-signature.js";
import { setPaymentGatewayForTests, createPaymentUsecase, requestRefundUsecase, reconcilePendingPaymentsUsecase } from "../src/application/payment/payment.usecases.js";
import { drainInboxOnce, countDeadLetteredEvents } from "../src/integrations/pagarme/worker.js";
import { setInternalTokenForTests } from "../src/http/routes/pagarme-internal.routes.js";
import { PaymentGatewayError, type GatewayCharge, type PaymentGateway } from "../src/domain/payment.js";

const SECRET = "sk_test_pagarme_secret_de_teste";

// ---------- dublê do gateway ----------
// Um gateway em memória: cada teste configura o que `create`/`find`/`refund`
// devolvem. É o que a spec §27 chama de MockPaymentGateway — o domínio não
// conhece o Pagar.me, então trocar a implementação não muda o teste.
function makeGateway(overrides: Partial<PaymentGateway> = {}): PaymentGateway & { calls: { create: number; find: number; refund: number; cancel: number } } {
  const calls = { create: 0, find: 0, refund: 0, cancel: 0 };
  return {
    calls,
    async create() {
      calls.create++;
      return {
        providerOrderId: "or_test_123",
        providerPaymentId: "pay_test_123",
        status: "pending",
        amount: 19,
        pix: { qrCode: "000201...", qrCodeBase64: "base64...", txid: "txid123", expiresAt: "2026-10-04T23:59:59Z" },
      } satisfies GatewayCharge;
    },
    async find() {
      calls.find++;
      return null;
    },
    async cancel() {
      calls.cancel++;
    },
    async refund() {
      calls.refund++;
      return { providerRefundId: "re_test_1" };
    },
    ...overrides,
  };
}

async function enablePagarme() {
  await db.update(storeSettings).set({ pagarmeEnabled: true }).where(eq(storeSettings.id, "singleton"));
}

async function openOrderWithItems(): Promise<string> {
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

function sign(body: string): string {
  return crypto.createHmac("sha1", SECRET).update(body, "utf8").digest("hex");
}

// O helper `api` não aceita headers arbitrários, então o webhook vai por inject.
async function postWebhookRaw(payload: unknown, signature?: string) {
  const { testApp } = await import("./helpers.js");
  const app = await testApp();
  const body = JSON.stringify(payload);
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/pagarme",
    headers: {
      "content-type": "application/json",
      "x-hub-signature": signature ?? sign(body),
      "x-forwarded-for": "10.0.0.1",
    },
    payload: body,
  });
  return { status: res.statusCode, json: res.json() };
}

describe("domínio de pagamento — máquina de estados (spec §18)", () => {
  it("transições válidas e inválidas", () => {
    expect(canTransition("pending", "paid")).toBe(true);
    expect(canTransition("processing", "paid")).toBe(true);
    expect(canTransition("paid", "refunded")).toBe(true);
    expect(canTransition("paid", "partially_refunded")).toBe(true);
    expect(canTransition("partially_refunded", "refunded")).toBe(true);
    // REFUNDED -> PAID é o exemplo da spec de transição inválida.
    expect(canTransition("refunded", "paid")).toBe(false);
    expect(canTransition("failed", "paid")).toBe(false);
    expect(canTransition("canceled", "paid")).toBe(false);
  });

  it("terminais não aceitam nada", () => {
    expect(isTerminal("refunded")).toBe(true);
    expect(isTerminal("canceled")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("paid")).toBe(false);
  });

  it("assertTransition lança em inválida", () => {
    expect(() => assertTransition("refunded", "paid")).toThrow();
    expect(() => assertTransition("pending", "paid")).not.toThrow();
  });

  it("refundableAmount e isFullyRefunded", () => {
    expect(refundableAmount(100, 30)).toBe(70);
    expect(refundableAmount(100, 100)).toBe(0);
    expect(isFullyRefunded(100, 100)).toBe(true);
    expect(isFullyRefunded(100, 99.99)).toBe(false);
  });
});

describe("mapper — tradução Pagar.me <-> domínio", () => {
  it("mapStatus é case-insensitive e cobre cancelled/canceled", () => {
    expect(mapStatus("paid")).toBe("paid");
    expect(mapStatus("PAID")).toBe("paid");
    expect(mapStatus("cancelled")).toBe("canceled");
    expect(mapStatus("canceled")).toBe("canceled");
    expect(mapStatus("refunded")).toBe("refunded");
    expect(mapStatus("algo-novo")).toBeNull();
    expect(mapStatus(undefined)).toBeNull();
  });

  it("mapPaymentMethod trata Pix com P maiúsculo (a doc escreve assim)", () => {
    expect(mapPaymentMethod("pix")).toBe("pix");
    expect(mapPaymentMethod("Pix")).toBe("pix");
    expect(mapPaymentMethod("credit_card")).toBe("credit_card");
    expect(mapPaymentMethod("boleto")).toBeNull();
  });

  it("toCents/fromCents", () => {
    expect(toCents(89.9)).toBe(8990);
    expect(fromCents(8990)).toBe(89.9);
    expect(fromCents(undefined)).toBeUndefined();
  });

  it("buildCreateOrderBody: items[].amount é UNITÁRIO e não há total no pedido", () => {
    const body = buildCreateOrderBody({
      orderId: "o1",
      code: "o1",
      items: [{ code: "p1", description: "Chopp", quantity: 2, unitAmount: 9.5 }],
      customer: { name: "João" },
      method: "pix",
      amount: 19,
    }) as any;
    expect(body.items[0].amount).toBe(950); // unitário em centavos
    expect(body.items[0].quantity).toBe(2);
    expect(body.amount).toBeUndefined(); // o pedido não tem campo de total
    expect(body.payments[0].payment_method).toBe("pix");
    expect(body.closed).toBe(false);
  });

  it("buildCreateOrderBody: cartão vai por card_token, nunca por card com PAN", () => {
    const body = buildCreateOrderBody({
      orderId: "o1",
      code: "o1",
      items: [{ code: "p1", description: "X", quantity: 1, unitAmount: 10 }],
      customer: { name: "João" },
      method: "credit_card",
      amount: 10,
      cardToken: "tok_123",
    }) as any;
    expect(body.payments[0].credit_card.card_token).toBe("tok_123");
    expect(body.payments[0].credit_card.card).toBeUndefined();
  });

  it("mapOrderToCharge acha o QR em payments[].pix e em payments[].last_transaction.pix", () => {
    const a = mapOrderToCharge({
      id: "or_1",
      status: "pending",
      amount: 1900,
      payments: [{ id: "pay_1", status: "pending", amount: 1900, pix: { qr_code: "QR1", txid: "t1" } }],
    });
    expect(a.pix?.qrCode).toBe("QR1");

    const b = mapOrderToCharge({
      id: "or_2",
      status: "pending",
      amount: 1900,
      payments: [{ id: "pay_2", status: "pending", amount: 1900, last_transaction: { pix: { qr_code: "QR2" } } }],
    });
    expect(b.pix?.qrCode).toBe("QR2");
  });
});

describe("assinatura do webhook", () => {
  it("aceita assinatura válida e rejeita inválida", () => {
    const body = JSON.stringify({ id: "evt_1", type: "order.paid" });
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, "deadbeef".repeat(5), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, `sha1=${sign(body)}`, SECRET)).toBe(true);
  });
});

describe("criação de cobrança — idempotência (spec §17)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(async () => {
    await resetState();
    await enablePagarme();
  });

  it("duplo clique em Pagar não cria duas cobranças", async () => {
    const gateway = makeGateway();
    setPaymentGatewayForTests(gateway);
    const orderId = await openOrderWithItems();

    const a = await createPaymentUsecase({ orderId, method: "pix" });
    const b = await createPaymentUsecase({ orderId, method: "pix" });

    expect(gateway.calls.create).toBe(1);
    expect(a.id).toBe(b.id);
    expect(a.pix?.qrCode).toBe("000201...");
  });

  it("falha do gateway marca a tentativa como failed, não apaga", async () => {
    const gateway = makeGateway({
      async create() {
        throw new PaymentGatewayError("gateway fora", "unavailable", 503, true);
      },
    });
    setPaymentGatewayForTests(gateway);
    const orderId = await openOrderWithItems();

    await expect(createPaymentUsecase({ orderId, method: "pix" })).rejects.toMatchObject({ code: "service_unavailable" });
    const rows = await db.select().from(payments).where(eq(payments.orderId, orderId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].failureReason).toContain("gateway fora");
  });

  it("cartão sem token é recusado antes de chamar o gateway", async () => {
    const gateway = makeGateway();
    setPaymentGatewayForTests(gateway);
    const orderId = await openOrderWithItems();
    await expect(createPaymentUsecase({ orderId, method: "credit_card" })).rejects.toMatchObject({ code: "validation_failed" });
    expect(gateway.calls.create).toBe(0);
  });
});

describe("webhook — idempotência e ponte com order_payment (spec §12, §16)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(async () => {
    await resetState();
    await enablePagarme();
  });

  it("order.paid confirma a cobrança e escreve order_payment confirmada; reenvio não duplica", async () => {
    const gateway = makeGateway();
    setPaymentGatewayForTests(gateway);
    const orderId = await openOrderWithItems();
    const created = await createPaymentUsecase({ orderId, method: "pix" });

    const payload = {
      id: "evt_paid_1",
      type: "order.paid",
      data: { id: "or_test_123", status: "paid", amount: 1900, paid_amount: 1900, payments: [{ id: "pay_test_123", status: "paid", amount: 1900 }] },
    };

    const first = await postWebhookRaw(payload);
    expect(first.status).toBe(200);
    await drainInboxOnce();

    let row = await db.query.payments.findFirst({ where: eq(payments.id, created.id) });
    expect(row?.status).toBe("paid");
    expect(row?.paidAt).toBeTruthy();

    // A ponte: order_payment confirmada para a comanda fechar e o relatório ver.
    const lines = await db.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    expect(lines).toHaveLength(1);
    expect(lines[0].confirmed).toBe(true);
    expect(lines[0].method).toBe("pix");

    // Reenvio do MESMO evento: 200, mas sem efeito novo.
    const second = await postWebhookRaw(payload);
    expect(second.status).toBe(200);
    await drainInboxOnce();

    const linesAfter = await db.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    expect(linesAfter).toHaveLength(1);
    const events = await db.select().from(paymentEvents).where(eq(paymentEvents.eventId, "evt_paid_1"));
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("processed");
  });

  it("assinatura inválida é 401 e não grava evento", async () => {
    const res = await postWebhookRaw({ id: "evt_x", type: "order.paid", data: {} }, "deadbeef".repeat(5));
    expect(res.status).toBe(401);
    const events = await db.select().from(paymentEvents);
    expect(events).toHaveLength(0);
  });

  it("evento de outro pedido é ignored, não processed", async () => {
    const payload = { id: "evt_other", type: "order.paid", data: { id: "or_desconhecido", status: "paid" } };
    await postWebhookRaw(payload);
    await drainInboxOnce();
    const events = await db.select().from(paymentEvents).where(eq(paymentEvents.eventId, "evt_other"));
    expect(events[0].status).toBe("ignored");
  });
});

describe("estorno parcial (spec §21)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(async () => {
    await resetState();
    await enablePagarme();
  });

  it("estorno maior que o saldo é 422", async () => {
    const gateway = makeGateway();
    setPaymentGatewayForTests(gateway);
    const orderId = await openOrderWithItems();
    const created = await createPaymentUsecase({ orderId, method: "pix" });

    // força o pagamento para paid via webhook
    await postWebhookRaw({ id: "evt_p", type: "order.paid", data: { id: "or_test_123", status: "paid", amount: 1900, paid_amount: 1900, payments: [{ id: "pay_test_123", status: "paid", amount: 1900 }] } });
    await drainInboxOnce();

    await expect(requestRefundUsecase({ paymentId: created.id, amount: 999, userId: FIXTURE.manager })).rejects.toMatchObject({ code: "invalid_refund_amount" });
  });

  it("estorno parcial marca partially_refunded e acumula", async () => {
    const gateway = makeGateway();
    setPaymentGatewayForTests(gateway);
    const orderId = await openOrderWithItems();
    const created = await createPaymentUsecase({ orderId, method: "pix" });
    await postWebhookRaw({ id: "evt_p2", type: "order.paid", data: { id: "or_test_123", status: "paid", amount: 1900, paid_amount: 1900, payments: [{ id: "pay_test_123", status: "paid", amount: 1900 }] } });
    await drainInboxOnce();

    const r = await requestRefundUsecase({ paymentId: created.id, amount: 5, userId: FIXTURE.manager });
    expect(r.status).toBe("succeeded");

    const row = await db.query.payments.findFirst({ where: eq(payments.id, created.id) });
    expect(row?.status).toBe("partially_refunded");
    expect(row?.refundedAmount).toBe(5);

    const refunds = await db.select().from(paymentRefunds).where(eq(paymentRefunds.paymentId, created.id));
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount).toBe(5);
  });
});

describe("reconciliação (spec §22)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(async () => {
    await resetState();
    await enablePagarme();
  });

  it("webhook perdido: reconciliação relê o gateway e confirma", async () => {
    const gateway = makeGateway({
      async find() {
        return { providerOrderId: "or_test_123", status: "paid", amount: 19, paidAmount: 19 };
      },
    });
    setPaymentGatewayForTests(gateway);
    const orderId = await openOrderWithItems();
    const created = await createPaymentUsecase({ orderId, method: "pix" });

    // Nenhum webhook chegou. A reconciliação pergunta ao gateway.
    const result = await reconcilePendingPaymentsUsecase();
    expect(result.changed).toBe(1);

    const row = await db.query.payments.findFirst({ where: eq(payments.id, created.id) });
    expect(row?.status).toBe("paid");

    const lines = await db.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    expect(lines).toHaveLength(1);
    expect(lines[0].confirmed).toBe(true);
  });
});

describe("inbox — retry com backoff e DLQ (spec §23)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(async () => {
    await resetState();
    await enablePagarme();
  });

  /**
   * Evento cujo processamento sempre estoura: `resolvePaymentForEvent` faz
   * `JSON.parse(event.payload)`, então um payload que não é JSON quebra o
   * `processPaymentEventUsecase` — que é o que faz o drain cair no `catch` e
   * chamar o requeue. É o caminho de falha de verdade, sem dublê de gateway.
   */
  async function insertQueAlwaysFails(eventId: string) {
    const [ev] = await db
      .insert(paymentEvents)
      .values({
        provider: "pagarme",
        eventId,
        eventType: "order.paid",
        payload: "isto-nao-e-json",
        status: "received",
        createdAt: new Date().toISOString(),
      })
      .returning();
    return ev!;
  }

  const ler = async (id: string) =>
    (await db.query.paymentEvents.findFirst({ where: eq(paymentEvents.id, id) }))!;

  /** Enche um campo de tempo (ou um status) direto, sem esperar o backoff real. */
  const setCampo = async (id: string, campo: Partial<typeof paymentEvents.$inferInsert>) => {
    await db.update(paymentEvents).set(campo).where(eq(paymentEvents.id, id));
  };

  it("evento novo (received + next_attempt_at NULL) é selecionável pelo drain", async () => {
    const ev = await insertQueAlwaysFails("evt_novo");
    expect(await drainInboxOnce()).toBe(1);
    expect((await ler(ev.id)).attempts).toBe(1); // a tentativa foi contada
  });

  it("REPRODUÇÃO: o evento reenfileirado não é selecionável — o retry morre", async () => {
    const ev = await insertQueAlwaysFails("evt_repro");
    expect(await drainInboxOnce()).toBe(1); // 1a tentativa: falha e reenfileira

    const depois = await ler(ev.id);
    // Reenfileirado = estado elegível: `failed` + backoff no futuro. O que o
    // drain aceita é `received` + NULL, ou `failed` + vencido.
    expect(depois.status).toBe("failed");
    expect(depois.nextAttemptAt).not.toBeNull();
    expect(depois.attempts).toBe(1);

    // O bug: reenfileirado, com backoff pendente, NÃO é selecionado — e não é
    // só porque o backoff não venceu. É porque o drain não tem nenhum ramo que
    // case com `received` + `next_attempt_at` preenchido (o primeiro ramo exige
    // `isNull(next_attempt_at)`, e o segundo exige `status = 'failed'`).
    expect(await drainInboxOnce()).toBe(0);
  });

  it("corrigido: reenfileirado volta a ser selecionado quando o backoff vence", async () => {
    const ev = await insertQueAlwaysFails("evt_retry");
    expect(await drainInboxOnce()).toBe(1);

    // Backoff ainda no futuro: invisível para o drain (senão seria tight loop).
    expect(await drainInboxOnce()).toBe(0);

    // Backoff vencido (o backoff real de 30s+ não é esperado no teste):
    // volta para a fila e a tentativa é contada.
    await setCampo(ev.id, { nextAttemptAt: new Date(Date.now() - 1000).toISOString() });
    expect(await drainInboxOnce()).toBe(1);
    expect((await ler(ev.id)).attempts).toBe(2);
  });

  it("corrigido: evento que estoura o teto de tentativas para em DLQ visível", async () => {
    const ev = await insertQueAlwaysFails("evt_dlq");

    // 1a tentativa: o estado inicial (`received` + `next_attempt_at` NULL) é
    // elegível sem tocar em nada — é o que o webhook deixa ao gravar.
    let selecionado = await drainInboxOnce();
    let voltas = selecionado > 0 ? 1 : 0;

    // Cada volta representa um backoff vencido: o drain seleciona, o
    // processamento falha, e o requeue ou reenfileira com data futura ou
    // escreve a DLQ. O backoff real (30s, 60s, ...) não é esperado no teste,
    // então o `next_attempt_at` é jogado para o passado direto.
    while (voltas < 20) {
      const atual = await ler(ev.id);
      // DLQ é `failed` + `next_attempt_at` NULL: o evento parou. Sem esta
      // guarda o laço ressuscitaria o evento da DLQ, porque expirar o
      // `next_attempt_at` de um `failed` o torna elegível de novo.
      if (atual.status === "failed" && atual.nextAttemptAt === null) break;
      await setCampo(ev.id, { nextAttemptAt: new Date(Date.now() - 1000).toISOString() });
      selecionado = await drainInboxOnce();
      if (selecionado === 0) break;
      voltas++;
    }

    const final = await ler(ev.id);
    expect(voltas).toBe(5); // 5 tentativas, e para: não fica reprocessando para sempre
    expect(final.status).toBe("failed");
    expect(final.attempts).toBe(5); // teto de 5 tentativas
    // DLQ = `failed` + `next_attempt_at` NULL. É o que o operador enxerga.
    expect(final.nextAttemptAt).toBeNull();
    expect(await countDeadLetteredEvents()).toBe(1);

    // E, uma vez na DLQ, o drain não ressuscita o evento.
    expect(await drainInboxOnce()).toBe(0);
  });
});

describe("canal interno com o serviço Go (pagarme-webhook)", () => {
  const TOKEN = "tok_interno_de_teste";
  const ROTA_EVENTO = "/internal/pagarme/events/";
  const ROTA_CARGA = "/internal/pagarme/charges/apply";

  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(async () => {
    await resetState();
    await enablePagarme();
  });
  afterEach(() => setInternalTokenForTests(undefined));

  /** POST no canal interno com o header canônico. */
  const post = (url: string, body: unknown, token: string | null = TOKEN) =>
    api("post", url, { body, headers: token ? { "x-internal-token": token } : {} });

  /** Cobrança paga no dialeto do Go, apontando para a cobrança local criada. */
  const chargePago = (orderId: string) => ({
    providerOrderId: "or_test_123",
    providerPaymentId: "pay_test_123",
    status: "paid",
    amount: 19,
    paidAmount: 19,
  });

  /** Cria a cobrança local (pending) e devolve o id. */
  async function cobrancaPendente() {
    const gateway = makeGateway();
    setPaymentGatewayForTests(gateway);
    const orderId = await openOrderWithItems();
    const created = await createPaymentUsecase({ orderId, method: "pix" });
    return { orderId, paymentId: created.id };
  }

  // ---------- token ----------

  it("sem token é 401", async () => {
    const res = await post(ROTA_CARGA, { source: "reconciliation", charge: chargePago("x") }, null);
    expect(res.status).toBe(401);
  });

  it("token errado é 401 — e a resposta não distingue do ausente", async () => {
    const errado = await post(ROTA_CARGA, { source: "reconciliation", charge: chargePago("x") }, "token-errado");
    const ausente = await post(ROTA_CARGA, { source: "reconciliation", charge: chargePago("x") }, null);
    expect(errado.status).toBe(401);
    expect(ausente.status).toBe(401);
    // Mesmo corpo: não diz qual dos dois foi, nem se o token existe.
    expect(errado.body).toBe(ausente.body);
  });

  it("token correto é aceito", async () => {
    await cobrancaPendente();
    const res = await post(ROTA_CARGA, { source: "reconciliation", charge: chargePago("x") });
    expect(res.status).toBe(200);
  });

  it("Authorization: Bearer é aceito como alias do header canônico", async () => {
    await cobrancaPendente();
    const res = await api("post", ROTA_CARGA, {
      body: { source: "reconciliation", charge: chargePago("x") },
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("sem PAGARME_INTERNAL_TOKEN no servidor, recusa com 401 (nunca aceita)", async () => {
    setInternalTokenForTests(null);
    await cobrancaPendente();
    const res = await post(ROTA_CARGA, { source: "reconciliation", charge: chargePago("x") }, "qualquer-coisa");
    expect(res.status).toBe(401);
  });

  // ---------- validação ----------

  it("charge.status fora do vocabulário é 422 (e não 500)", async () => {
    await cobrancaPendente();
    const res = await post(ROTA_CARGA, {
      source: "reconciliation",
      charge: { providerOrderId: "or_test_123", status: "nao_existe", amount: 19 },
    });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("invalid_internal_charge");
  });

  it("charge ausente é 422, e source inválida é 422", async () => {
    await cobrancaPendente();
    expect((await post(ROTA_CARGA, { source: "reconciliation" })).status).toBe(422);
    expect(
      (await post(ROTA_CARGA, { source: "outro", charge: chargePago("x") })).status,
    ).toBe(422);
  });

  it("paidAmount ausente continua ausente (não vira 0)", async () => {
    const { paymentId } = await cobrancaPendente();
    await post(ROTA_CARGA, {
      source: "reconciliation",
      // sem `paidAmount`: o `applyCharge` guarda `!= null && > 0`, então
      // ausente tem de chegar como `undefined`, não como 0.
      charge: { providerOrderId: "or_test_123", status: "paid", amount: 19 },
    });
    const row = await db.query.payments.findFirst({ where: eq(payments.id, paymentId) });
    expect(row?.status).toBe("paid");
    expect(row?.amount).toBe(19);
  });

  // ---------- source escolhe a guarda ----------

  it("source reconciliation recusa paid sobre refunded: 200 com applied:false", async () => {
    const { paymentId } = await cobrancaPendente();
    await db.update(payments).set({ status: "refunded" }).where(eq(payments.id, paymentId));

    const res = await post(ROTA_CARGA, { source: "reconciliation", charge: chargePago("x") });
    expect(res.status).toBe(200);
    expect(res.json.applied).toBe(false);
    expect(res.json.reason).toBe("no_transition");

    // O dinheiro não foi revertido: segue refunded.
    const row = await db.query.payments.findFirst({ where: eq(payments.id, paymentId) });
    expect(row?.status).toBe("refunded");
  });

  it("source event grava direto (mesmo estado que o webhook de hoje)", async () => {
    const { orderId, paymentId } = await cobrancaPendente();
    const [ev] = await db
      .insert(paymentEvents)
      .values({
        provider: "pagarme",
        eventId: "evt_int",
        eventType: "order.paid",
        payload: "{}",
        status: "received",
        createdAt: new Date().toISOString(),
      })
      .returning();

    const res = await post(`${ROTA_EVENTO}${ev.id}/apply`, {
      source: "event",
      eventType: "order.paid",
      charge: chargePago(orderId),
    });
    expect(res.status).toBe(200);
    expect(res.json.applied).toBe(true);
    expect(res.json.status).toBe("paid");

    const row = await db.query.payments.findFirst({ where: eq(payments.id, paymentId) });
    expect(row?.status).toBe("paid");

    // O evento foi LIGADO à cobrança...
    const ligado = await db.query.paymentEvents.findFirst({ where: eq(paymentEvents.id, ev.id) });
    expect(ligado?.paymentId).toBe(paymentId);
    // ... mas `status`/`attempts`/`next_attempt_at` são do Go, não nossos.
    expect(ligado?.status).toBe("received");
    expect(ligado?.attempts).toBe(0);
    expect(ligado?.nextAttemptAt).toBeNull();
  });

  it("404 quando não casa com cobrança nenhuma", async () => {
    await cobrancaPendente();
    const res = await post(ROTA_CARGA, {
      source: "reconciliation",
      charge: { providerOrderId: "or_que_nao_existe", status: "paid", amount: 19 },
    });
    expect(res.status).toBe(404);
  });

  it("404 quando a linha da inbox não existe", async () => {
    await cobrancaPendente();
    const res = await post(`${ROTA_EVENTO}uuid-que-nao-existe/apply`, {
      source: "event",
      charge: chargePago("x"),
    });
    expect(res.status).toBe(404);
  });

  // ---------- idempotência (at-least-once) ----------

  it("at-least-once: reentregar o MESMO evento não duplica order_payment nem audit_log", async () => {
    const { orderId } = await cobrancaPendente();
    const [ev] = await db
      .insert(paymentEvents)
      .values({
        provider: "pagarme",
        eventId: "evt_at_least_once",
        eventType: "order.paid",
        payload: "{}",
        status: "received",
        createdAt: new Date().toISOString(),
      })
      .returning();
    const corpo = { source: "event", eventType: "order.paid", charge: chargePago(orderId) };

    // A primeira entrega aplica. A segunda é o "a transação do Node commitou,
    // o bookkeeping do Go falhou" que a entrega at-least-once representa.
    const primeira = await post(`${ROTA_EVENTO}${ev.id}/apply`, corpo);
    const segunda = await post(`${ROTA_EVENTO}${ev.id}/apply`, corpo);
    expect(primeira.status).toBe(200);
    expect(segunda.status).toBe(200);
    expect(primeira.json.applied).toBe(true);
    expect(segunda.json.status).toBe("paid");

    // Uma linha só em `order_payment`: a ponte é idempotente por
    // `(method, amount)`.
    const linhas = await db.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    expect(linhas).toHaveLength(1);

    // E UM registro de auditoria: o `logAction` só roda quando o status muda
    // de fato, e a segunda entrega é `alvo === atual` (no-op no `applyCharge`).
    const logs = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "payment_status_changed"), eq(auditLog.orderId, orderId)));
    expect(logs).toHaveLength(1);
  });
});