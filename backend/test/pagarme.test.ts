import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { api, seedFixture, resetState, closeTestApp, cashier, manager, waiter, FIXTURE, raw } from "./helpers.js";
import { db } from "../src/infra/db/client.js";
import { eq } from "drizzle-orm";
import { payments, paymentEvents, paymentRefunds, orderPayments, storeSettings } from "../src/infra/db/schema.js";
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
import { drainInboxOnce } from "../src/integrations/pagarme/worker.js";
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