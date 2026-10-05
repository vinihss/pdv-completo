// Aplicação da cobrança no Pagar.me (spec §9-§22).
//
// Onde cada regra da spec mora:
//
//   §9  endpoints          -> http/routes/payment.routes.ts
//   §12 fluxo do Pix       -> createPaymentUsecase + o worker do webhook
//   §15/§16 webhook       -> recordWebhookEventUsecase + processPaymentEventUsecase
//   §17 idempotência      -> reuso da cobrança viva + uq_payment_order_attempt
//   §18 transições        -> domain/payment.ts (assertTransition)
//   §19 retry do cliente  -> tentativa nova (attempt+1), antigas auditáveis
//   §20/§21 cancel/estorno-> cancelPaymentUsecase / requestRefundUsecase
//   §22 reconciliação     -> reconcilePendingPaymentsUsecase
//
// ## A regra que atravessa o arquivo inteiro
//
// A CONFIRMAÇÃO DO PAGAMENTO NUNCA VEM DA RESPOSTA DA CRIAÇÃO. `create` grava
// a linha local como `pending` e devolve; o que muda para `paid` é o webhook
// (evento `order.paid`) ou, se ele se perder, a reconciliação relendo o
// gateway. Isso é a spec §12 ("o retorno da criação não deve ser interpretado
// como pagamento confirmado") e é também a única leitura segura: um 200 da
// criação é o gateway aceitando o pedido de cobrança, não o dinheiro entrando.
//
// ## Por que o pagamento do gateway escreve em `order_payment`
//
// A comanda só fecha com pagamento confirmado, e a fonte de verdade dessa
// confirmação é `order_payment.confirmed` (cash-flow e relatórios leem lá).
// Se o Pix pago pelo cliente não produzisse uma linha confirmada, o pedido pago
// no online ficaria aberto esperando alguém anotar "pago" no balcão — que é
// exatamente o que a integração existe para eliminar. Então `paid` escreve a
// linha, com `SYSTEM_USER_ID` como responsável (o mesmo que o ingest do iFood
// usa, application/self-service: id 'system', active false, nunca autentica).
//
// Duas consequências deliberadas:
//   - a linha entra CONFIRMADA de uma vez, porque o gateway confirmou. Ela não
//     passa por `requireOpenDrawerForCash` (nunca é dinheiro) e não aparece na
//     contagem da gaveta, que filtra `method='cash'`;
//   - o pedido NÃO é fechado aqui. `status` continua `open` e quem fecha é o
//     garçom/gerente. Automatizar o fechamento mudaria o meaning do botão
//     "fechar comanda" em todo o app.
//
// Idempotente pelo ponto de vista do dinheiro: se já existe linha confirmada
// para a comanda com o mesmo valor, não cria outra.

import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db, type Tx } from "../../infra/db/client.js";
import { customers, orderItems, orderPayments, orders, paymentEvents, paymentRefunds, payments, products, storeSettings } from "../../infra/db/schema.js";
import { isUniqueViolation } from "../../infra/db/errors.js";
import { logAction } from "../../infra/audit-log.js";
import { SYSTEM_USER_ID } from "../../domain/constants.js";
import { moneyEq, round2 } from "../../domain/money.js";
import { Errors, AppError } from "../../domain/errors.js";
import {
  assertTransition,
  isFullyRefunded,
  PaymentGatewayError,
  refundableAmount,
  type GatewayCharge,
  type PaymentGateway,
  type PaymentMethod,
  type PaymentStatus,
} from "../../domain/payment.js";
import { PagarmeGateway } from "../../integrations/pagarme/gateway.js";
import { isPagarmeEnabled } from "../../integrations/pagarme/config.js";
import { mapOrderToCharge } from "../../integrations/pagarme/mapper.js";
import type { PagarmeWebhookPayload } from "../../integrations/pagarme/types.js";
import { computeOrderTotal } from "../order/order.usecases.js";

export const PROVIDER = "pagarme";

// Um gateway por processo. A classe é stateless (só chama o client), então
// instanciar por chamada também funcionaria — mas a injeção abaixo existe para
// os testes trocarem por um dublê sem mock de módulo.
let gatewayOverride: PaymentGateway | null = null;
export function setPaymentGatewayForTests(gateway: PaymentGateway | null): void {
  gatewayOverride = gateway;
}
function gateway(): PaymentGateway {
  return gatewayOverride ?? new PagarmeGateway();
}

/** Erro do gateway virado em erro do PDV, uma vez só (spec §26). */
function toAppError(err: unknown, fallback: string): never {
  if (!(err instanceof PaymentGatewayError)) throw err;
  switch (err.kind) {
    case "validation":
      // O gateway recusou o que mandamos. É erro nosso, de payload — 400 com o
      // motivo, que é o que o gerente precisa para corrigir.
      throw Errors.validationFailed({ reason: err.message });
    case "auth":
      // Chave ausente/errada: é configuração, não pedido do cliente.
      throw Errors.pagarmeNotConfigured(["PAGARME_SECRET_KEY"]);
    case "conflict":
      // O gateway já tem algo nesse código. 409 é o conflito de estado, e
      // repetir a operação não resolve — a reconciliação descobre o que houve.
      throw new AppError("payment_conflict", 409, "O Pagar.me recusou a operação por conflito.", {
        reason: err.message,
      });
    case "rate_limit":
    case "unavailable":
      // 503 e não 500: a culpa não é do pedido e o cliente pode repetir depois.
      // A mensagem não carrega o corpo do provedor.
      throw Errors.serviceUnavailable(fallback);
    default:
      throw Errors.pagarmeProviderError(err.message);
  }
}

/**
 * O módulo só opera com o toggle do gerente E a credencial. Sem os dois, o
 * recusa é `pagarme_not_configured` (409) — que diz O QUE falta, para o
 * gerente não ficar adivinhando entre "não liguei" e "falta a chave".
 */
async function requirePagarmeReady(): Promise<void> {
  const missing: string[] = [];
  const settings = await db.query.storeSettings.findFirst({ where: eq(storeSettings.id, "singleton") });
  if (!settings?.pagarmeEnabled) missing.push("store_settings.pagarme_enabled");
  if (!isPagarmeEnabled()) missing.push("PAGARME_ENABLED/PAGARME_SECRET_KEY");
  if (missing.length > 0) throw Errors.pagarmeNotConfigured(missing);
}

// ============================================================
// Leitura
// ============================================================

export type PaymentRow = typeof payments.$inferSelect;

function serializePayment(row: PaymentRow) {
  return {
    id: row.id,
    orderId: row.orderId,
    attempt: row.attempt,
    method: row.method,
    status: row.status,
    amount: row.amount,
    refundedAmount: row.refundedAmount,
    refundableAmount: refundableAmount(row.amount, row.refundedAmount),
    currency: row.currency,
    // O QR do gateway, quando veio. Ausente é caso normal (ver mapper.ts): a
    // cobrança existe e o frontend exibe o BR Code local como reserva.
    pix: row.qrCode
      ? { qrCode: row.qrCode, qrCodeBase64: row.qrCodeBase64, qrCodeUrl: row.qrCodeUrl, txid: row.pixTxid, expiresAt: row.pixExpiresAt }
      : null,
    cardLast4: (JSON.parse(row.metadata) as { cardLast4?: string }).cardLast4 ?? null,
    failureReason: row.failureReason,
    paidAt: row.paidAt,
    canceledAt: row.canceledAt,
    createdAt: row.createdAt,
  };
}

export async function getPaymentUsecase(paymentId: string) {
  const row = await db.query.payments.findFirst({ where: eq(payments.id, paymentId) });
  if (!row) throw Errors.paymentNotFound(paymentId);
  return serializePayment(row);
}

/** Tentativa mais recente primeiro — a que o cliente deve pagar agora. */
export async function listOrderPaymentsUsecase(orderId: string) {
  const rows = await db.query.payments.findMany({
    where: eq(payments.orderId, orderId),
    orderBy: (t, { desc }) => [desc(t.attempt)],
  });
  return rows.map(serializePayment);
}

// ============================================================
// §9.1 — criar cobrança
// ============================================================

export async function createPaymentUsecase(input: {
  orderId: string;
  method: PaymentMethod;
  cardToken?: string;
  cardId?: string;
  installments?: number;
}) {
  await requirePagarmeReady();

  const order = await db.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
  if (!order) throw Errors.notFound("Comanda");
  if (order.status !== "open") throw Errors.orderNotOpen();

  if (input.method === "credit_card" && !input.cardToken && !input.cardId) {
    // Cartão chega TOKENIZADO: o PAN/CVV ficam no navegador e no Pagar.me. Sem
    // token não há como cobrar — e não há, de propósito, campo para receber
    // número de cartão (PCI: ver buildCreateOrderBody).
    throw Errors.validationFailed({ field: "cardToken", reason: "cartão precisa ser tokenizado" });
  }

  const total = await db.transaction((tx) => computeOrderTotal(tx, order));
  if (total <= 0) throw Errors.validationFailed({ reason: "comanda sem itens para cobrar" });

  // ---------- §17: o duplo clique ----------
  // Se JÁ existe uma cobrança viva deste método, ela é a resposta. Não é
  // "otimismo": é a garantia de que "Pagar" duas vezes não gera dois QR codes,
  // e portanto não gera duas cobranças. Uma tentativa só morre quando o gateway
  // a recusou (failed/canceled/expirada) — aí entra uma nova, com attempt+1 e
  // as antigas permanecem auditáveis (§19).
  const viva = await db.query.payments.findFirst({
    where: and(eq(payments.orderId, order.id), eq(payments.method, input.method), inArray(payments.status, ["pending", "processing"])),
    orderBy: (t, { desc }) => [desc(t.attempt)],
  });
  if (viva) return serializePayment(viva);

  const anterior = await db.query.payments.findMany({
    where: eq(payments.orderId, order.id),
    orderBy: (t, { desc }) => [desc(t.attempt)],
    limit: 1,
  });
  const attempt = (anterior[0]?.attempt ?? 0) + 1;

  const items = await db
    .select({ code: orderItems.productId, description: products.name, quantity: orderItems.quantity, unitPrice: orderItems.unitPrice })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(and(eq(orderItems.orderId, order.id), eq(orderItems.status, "ordered")));

  const customer = order.customerId
    ? await db.query.customers.findFirst({ where: eq(customers.id, order.customerId) })
    : null;
  const settings = await db.query.storeSettings.findFirst({ where: eq(storeSettings.id, "singleton") });

  const now = new Date().toISOString();
  // A linha local ANTES da chamada: se a resposta se perder, o próximo ciclo de
  // reconciliação encontra a tentativa pelo par (order, attempt) e pergunta ao
  // gateway — em vez de a cobrança ter-existido-sido-um-crédulo.
  let row: PaymentRow;
  try {
    [row] = await db
      .insert(payments)
      .values({
        orderId: order.id,
        attempt,
        provider: PROVIDER,
        method: input.method,
        amount: total,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  } catch (err) {
    // Duas requisições concorrentes calcularam o mesmo attempt: o índice
    // uq_payment_order_attemptelecionou uma. A perdedora relê a da vencedora e
    // devolve ela — nunca 500, e nunca uma segunda cobrança.
    if (isUniqueViolation(err)) {
      const existente = await db.query.payments.findFirst({
        where: and(eq(payments.orderId, order.id), eq(payments.attempt, attempt)),
      });
      if (existente) return serializePayment(existente);
    }
    throw err;
  }

  try {
    const charge = await gateway().create({
      orderId: order.id,
      code: `${order.id.slice(0, 52)}`,
      items: items.map((i) => ({ code: i.code, description: i.description, quantity: i.quantity, unitAmount: i.unitPrice })),
      // `name` é o único campo obrigatório de customer na V5. Cliente sem
      // cadastro (pedido de balcão) cai no nome da loja em vez de mandar
      // string vazia, que o gateway rejeitaria.
      customer: {
        name: customer?.name ?? settings?.merchantName ?? "Cliente",
        email: customer?.email ?? undefined,
        code: customer?.id,
      },
      method: input.method,
      amount: total,
      cardToken: input.cardToken,
      cardId: input.cardId,
      installments: input.installments,
    });

    const [updated] = await db
      .update(payments)
      .set({
        providerOrderId: charge.providerOrderId,
        providerChargeId: charge.providerChargeId ?? null,
        providerPaymentId: charge.providerPaymentId ?? null,
        // Status NÃO é o da resposta: a cobrança pode já ter vindo `paid` (cartão
        // aprovado na hora), mas quem confirma isso é o webhook. Gravar `paid`
        // aqui reabriria a spec §12 pelo lado errado.
        qrCode: charge.pix?.qrCode ?? null,
        qrCodeBase64: charge.pix?.qrCodeBase64 ?? null,
        qrCodeUrl: charge.pix?.qrCodeUrl ?? null,
        pixTxid: charge.pix?.txid ?? null,
        pixExpiresAt: charge.pix?.expiresAt ?? null,
        metadata: JSON.stringify({
          cardLast4: charge.cardLast4,
          cardBrand: charge.cardBrand,
          gatewayStatus: charge.status,
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(payments.id, row.id))
      .returning();
    return serializePayment(updated);
  } catch (err) {
    // A tentativa fica marcada como falha em vez de ser apagada: "cobrança não
    // confirmada" é informação de auditoria, e é o que permite à reconciliação
    // e ao gerente verem que o cliente tentou.
    await db
      .update(payments)
      .set({
        status: "failed",
        failureReason: err instanceof Error ? err.message.slice(0, 500) : "erro desconhecido ao criar cobrança",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(payments.id, row.id));
    return toAppError(err, "O Pagar.me está indisponível para criar a cobrança.");
  }
}

// ============================================================
// §20 — cancelar
// ============================================================

export async function cancelPaymentUsecase(input: { paymentId: string; userId: string }) {
  const row = await db.query.payments.findFirst({ where: eq(payments.id, input.paymentId) });
  if (!row) throw Errors.paymentNotFound(input.paymentId);
  if (!row.providerOrderId) throw Errors.invalidTransition("Cobrança ainda não tem id no gateway.");
  if (row.status === "canceled") return serializePayment(row); // idempotente
  // Cancelar uma cobrança já estornada é pedir para o gateway devolver dinheiro
  // que não existe; terminal é terminal.
  if (row.status === "refunded" || row.status === "partially_refunded") {
    throw Errors.invalidTransition("Pagamento já estornado não pode ser cancelado.");
  }

  try {
    await gateway().cancel(row.providerOrderId);
  } catch (err) {
    return toAppError(err, "O Pagar.me está indisponível para cancelar.");
  }

  await db.transaction(async (tx) => {
    // Log da INTENÇÃO. O status vira `canceled` quando o evento chegar (§20):
    // marcar aqui seria declarar cancelado algo que o gateway pode recusar.
    await logAction(tx, input.userId, "payment_cancel_requested", row.orderId, {
      paymentId: row.id,
      attempt: row.attempt,
      providerOrderId: row.providerOrderId,
    });
  });
  return serializePayment(row);
}

// ============================================================
// §21 — estorno (integral ou parcial)
// ============================================================

export async function requestRefundUsecase(input: {
  paymentId: string;
  amount?: number;
  reason?: string;
  userId: string;
}) {
  const row = await db.query.payments.findFirst({ where: eq(payments.id, input.paymentId) });
  if (!row) throw Errors.paymentNotFound(input.paymentId);
  if (!row.providerOrderId) throw Errors.invalidTransition("Cobrança ainda não tem id no gateway.");

  if (row.status !== "paid" && row.status !== "partially_refunded") {
    // Estornar o que não foi pago não é estorno: o dinheiro não entrou.
    throw Errors.invalidTransition(`Só se estorna pagamento pago (este está ${row.status}).`);
  }

  const disponivel = refundableAmount(row.amount, row.refundedAmount);
  const valor = input.amount != null ? round2(input.amount) : disponivel;
  if (valor <= 0) throw Errors.invalidRefundAmount(valor, disponivel);
  // Estorno maior que o saldo é sempre erro de quem pediu, nunca da fila.
  if (valor - disponivel > 0.001) throw Errors.invalidRefundAmount(valor, disponivel);

  const agora = new Date().toISOString();
  const [refund] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(paymentRefunds)
      .values({
        paymentId: row.id,
        amount: valor,
        status: "requested",
        reason: input.reason ?? null,
        requestedBy: input.userId,
        requestedAt: agora,
        createdAt: agora,
        updatedAt: agora,
      })
      .returning();
    // A linha do pedido de estorno é gravada ANTES da chamada: se a resposta
    // se perder, o próximo ciclo pergunta o status em vez de o processo
    // "lembrar" o que pediu.
    await logAction(tx, input.userId, "payment_refund_requested", row.orderId, {
      paymentId: row.id,
      refundId: inserted[0].id,
      amount: valor,
      parcial: valor - disponivel < -0.001,
    });
    return inserted;
  });

  try {
    const result = await gateway().refund(row.providerOrderId, valor);
    const [settled] = await db
      .update(paymentRefunds)
      .set({
        providerRefundId: result.providerRefundId ?? null,
        status: "succeeded",
        settledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(paymentRefunds.id, refund.id))
      .returning();

    // O gateway aceitou o estorno: é a confirmação síncrona. Atualizamos o
    // acumulado e o status AGORA, porque sem isso dois pedidos de estorno
    // concorrentes passariam os dois na checagem de saldo (o `refundedAmount`
    // só mudaria quando o webhook chegasse). O webhook `charge.refunded`
    // reconfirma depois — idempotente, porque o valor já está gravado.
    const novoRefunded = round2(row.refundedAmount + valor);
    const novoStatus: PaymentStatus = isFullyRefunded(row.amount, novoRefunded) ? "refunded" : "partially_refunded";
    await db
      .update(payments)
      .set({ refundedAmount: novoRefunded, status: novoStatus, updatedAt: new Date().toISOString() })
      .where(eq(payments.id, row.id));

    return { id: settled.id, amount: settled.amount, status: settled.status };
  } catch (err) {
    await db
      .update(paymentRefunds)
      .set({ status: "failed", updatedAt: new Date().toISOString() })
      .where(eq(paymentRefunds.id, refund.id));
    return toAppError(err, "O Pagar.me está indisponível para estornar.");
  }
}

// ============================================================
// §15/§16 — webhook: gravar ANTES do 200, processar depois
// ============================================================

/**
 * Grava o evento e devolve se é novo.
 *
 * `isNew: false` = o gateway reenviou algo que já temos (a doc diz que reenvia
 * enquanto não recebe 200, e a spec §16 exige um efeito só). A resposta do
 * endpoint é 200 nos dois casos — devolver erro aqui faria o Pagar.me reenviar
 * para sempre um evento que já foi tratado.
 */
export async function recordWebhookEventUsecase(payload: PagarmeWebhookPayload, correlationId?: string) {
  const eventId = payload.id;
  const eventType = payload.type ?? "unknown";
  if (!eventId) {
    // Sem id não há como deduplicar, e deduplicar é o requisito. Recusar é
    // melhor que aceitar um evento cego.
    throw Errors.validationFailed({ reason: "evento sem id" });
  }

  const data = payload.data;
  const providerPaymentId =
    data?.payments?.find((p) => p?.id)?.id ?? (data?.id?.startsWith("pay_") ? data.id : undefined);

  try {
    const [row] = await db
      .insert(paymentEvents)
      .values({
        provider: PROVIDER,
        eventId,
        eventType,
        providerOrderId: data?.id ?? null,
        providerPaymentId: providerPaymentId ?? null,
        payload: JSON.stringify(payload),
        status: "received",
        createdAt: new Date().toISOString(),
      })
      .returning();
    return { event: row, isNew: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await db.query.paymentEvents.findFirst({
        where: and(eq(paymentEvents.provider, PROVIDER), eq(paymentEvents.eventId, eventId)),
      });
      return { event: existing!, isNew: false };
    }
    throw err;
  }
}

/** Acha a cobrança local a que o evento pertence. `null` = não é nossa. */
async function resolvePaymentForEvent(event: typeof paymentEvents.$inferSelect): Promise<PaymentRow | null> {
  const payload = JSON.parse(event.payload) as PagarmeWebhookPayload;
  const data = payload.data;

  const candidates = [event.providerPaymentId, event.providerOrderId, data?.payments?.find((p) => p?.id)?.id, data?.id].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );

  for (const candidate of candidates) {
    const byPayment = await db.query.payments.findFirst({ where: eq(payments.providerPaymentId, candidate) });
    if (byPayment) return byPayment;
    const byOrder = await db.query.payments.findFirst({ where: eq(payments.providerOrderId, candidate) });
    if (byOrder) return byOrder;
  }
  return null;
}

/**
 * Aplica o estado do gateway numa cobrança local. ÚNICO lugar onde `payment.status`
 * muda, e tanto o webhook quanto a reconciliação passam por aqui — é o que impede
 * os dois caminhos de divergirem na regra.
 */
async function applyCharge(tx: Tx, row: PaymentRow, charge: GatewayCharge): Promise<PaymentRow> {
  const alvo = charge.status;
  const atual = row.status as PaymentStatus;

  // Evento velho/atrasado (o gateway reenvia depois do estorno): o estado local
  // mais novo ganha. Não é erro — é o mesmo evento chegando duas vezes em
  // ordens diferentes, e a spec §16 quer UM efeito, não um estado regredido.
  if (alvo === atual) return row;

  const agora = new Date().toISOString();
  const updates: Partial<typeof payments.$inferInsert> = {
    updatedAt: agora,
    // QR que só agora apareceu (a doc não diz onde vem — ver mapper.ts).
    qrCode: charge.pix?.qrCode ?? row.qrCode,
    qrCodeBase64: charge.pix?.qrCodeBase64 ?? row.qrCodeBase64,
    qrCodeUrl: charge.pix?.qrCodeUrl ?? row.qrCodeUrl,
    pixTxid: charge.pix?.txid ?? row.pixTxid,
    pixExpiresAt: charge.pix?.expiresAt ?? row.pixExpiresAt,
  };

  if (alvo === "paid") {
    updates.status = "paid";
    updates.paidAt = row.paidAt ?? agora;
    // Valor pago observado no gateway tem precedência sobre o valor criado: é o
    // número que o gateway diz ter recebido. `paidAmount` em reais.
    if (charge.paidAmount != null && charge.paidAmount > 0) updates.amount = round2(charge.paidAmount);
  } else if (alvo === "partially_refunded") {
    updates.status = "partially_refunded";
    // O gateway diz quanto já voltou; se não disser, mantém o acumulado local
    // (que o requestRefundUsecase já atualizou na aceitação).
    if (charge.refundedAmount != null) updates.refundedAmount = round2(charge.refundedAmount);
  } else if (alvo === "refunded") {
    updates.status = "refunded";
    updates.refundedAmount = charge.refundedAmount != null ? round2(charge.refundedAmount) : row.amount;
  } else if (alvo === "failed" || alvo === "canceled") {
    updates.status = alvo;
    if (alvo === "canceled") updates.canceledAt = agora;
  } else {
    // processing/pending: só o QR/status, sem mexer no dinheiro.
    updates.status = alvo;
  }

  const [updated] = await tx.update(payments).set(updates).where(eq(payments.id, row.id)).returning();

  // A transição é registrada no log estruturado da spec §25 — com o par
  // old/new, que é o que o painel financeiro vai querer ler.
  await logAction(tx, SYSTEM_USER_ID, "payment_status_changed", row.orderId, {
    event: "payment.status_changed",
    payment_id: row.id,
    order_id: row.orderId,
    provider: PROVIDER,
    provider_order_id: row.providerOrderId,
    provider_charge_id: row.providerChargeId,
    provider_payment_id: row.providerPaymentId,
    attempt: row.attempt,
    old_status: atual,
    new_status: alvo,
  });

  if (alvo === "paid") await bridgePaidToOrder(tx, updated);
  if (alvo === "refunded") await settleRefunds(tx, updated);

  return updated;
}

/**
 * §12 — pagamento confirmado vira linha confirmada em `order_payment`, para a
 * comanda poder fechar e para o relatório de vendas enxergar o dinheiro.
 *
 * Idempotente por construção: se já existe linha confirmada do mesmo método e
 * mesmo valor, não cria outra. Sem isso, um `order.paid` reenviado geraria
 * linhas duplicadas no relatório.
 */
async function bridgePaidToOrder(tx: Tx, row: PaymentRow) {
  const order = await tx.query.orders.findFirst({ where: eq(orders.id, row.orderId) });
  if (!order) return;

  // `pix` do gateway -> `pix` do balcão; `credit_card` -> `card` (o enum do
  // repo não tem credit_card, e o que o caixa entende é "cartão").
  const metodo = row.method === "pix" ? ("pix" as const) : ("card" as const);

  const jaExiste = await tx
    .select()
    .from(orderPayments)
    .where(
      and(
        eq(orderPayments.orderId, row.orderId),
        eq(orderPayments.method, metodo),
        eq(orderPayments.confirmed, true),
      ),
    );
  if (jaExiste.some((p) => moneyEq(p.amount, row.amount))) return;

  const agora = new Date().toISOString();
  await tx.insert(orderPayments).values({
    orderId: row.orderId,
    method: metodo,
    amount: row.amount,
    confirmed: true,
    confirmedAt: agora,
    confirmedBy: SYSTEM_USER_ID,
    createdBy: SYSTEM_USER_ID,
    createdAt: agora,
  });

  // `status` do pedido NÃO é tocado: fechar comanda continua sendo ato do
  // garçom/gerente. O que o gateway faz é satisfazer a exigência de "pagamento
  // registrado", e `paymentConfirmedAt/By` é quem deixa isso auditável.
  await tx
    .update(orders)
    .set({ paymentConfirmedAt: agora, paymentConfirmedBy: SYSTEM_USER_ID, paymentMethod: order.paymentMethod ?? metodo })
    .where(eq(orders.id, row.orderId));

  await logAction(tx, SYSTEM_USER_ID, "payment_confirmed", row.orderId, {
    paymentId: row.id,
    provider: PROVIDER,
    provider_order_id: row.providerOrderId,
    method: metodo,
    amount: row.amount,
    attempt: row.attempt,
  });
}

/** Pedidos de estorno abertos viram `succeeded` quando o pagamento volta integral. */
async function settleRefunds(tx: Tx, row: PaymentRow) {
  await tx
    .update(paymentRefunds)
    .set({ status: "succeeded", settledAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(and(eq(paymentRefunds.paymentId, row.id), eq(paymentRefunds.status, "requested")));
}

/**
 * Processa um evento já gravado. Chamado pelo worker (não pela rota HTTP), e
 * seguro para reexecução: evento `processed` sai cedo.
 */
export async function processPaymentEventUsecase(eventId: string): Promise<void> {
  const event = await db.query.paymentEvents.findFirst({ where: eq(paymentEvents.id, eventId) });
  if (!event || event.status === "processed") return;

  const row = await resolvePaymentForEvent(event);
  if (!row) {
    // Evento de outro pedido, ou de um pedido que nem criamos. Guardado como
    // `ignored` e não `processed`: a distinção importa na auditoria ("chegou
    // coisa que não era nossa") e `ignored` não é erro.
    await db
      .update(paymentEvents)
      .set({ status: "ignored", processedAt: new Date().toISOString() })
      .where(eq(paymentEvents.id, eventId));
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(paymentEvents)
      .set({ status: "processing", attempts: event.attempts + 1 })
      .where(eq(paymentEvents.id, eventId));

    const payload = JSON.parse(event.payload) as PagarmeWebhookPayload;
    let charge: GatewayCharge;
    try {
      charge = mapOrderToCharge(payload.data);
    } catch (err) {
      // Payload sem id não casa com nada: guardamos o texto e deixamos como
      // `failed` para a reconciliação do pagamento resolver pelo gateway.
      await tx
        .update(paymentEvents)
        .set({ status: "failed", errorMessage: err instanceof Error ? err.message.slice(0, 500) : "payload inválido" })
        .where(eq(paymentEvents.id, eventId));
      return;
    }

    // Só aponta o evento para a cobrança quando ela casar pelo id do gateway.
    await tx
      .update(paymentEvents)
      .set({ paymentId: row.id, providerOrderId: charge.providerOrderId, providerPaymentId: charge.providerPaymentId ?? null })
      .where(eq(paymentEvents.id, eventId));

    await applyCharge(tx, row, charge);

    await tx
      .update(paymentEvents)
      .set({ status: "processed", processedAt: new Date().toISOString(), errorMessage: null })
      .where(eq(paymentEvents.id, eventId));
  });
}

/**
 * Um evento cujo `status` ficou `failed` volta para a fila depois do backoff, com
 * teto de tentativas. Estourado o teto, ele PARA de ser reprocessado (`failed`
 * sem `next_attempt_at`): um evento que quebrou no código vai quebrar em todo
 * retry, e martelar o gateway não conserta — quem resolve é a reconciliação,
 * que relê o estado pelo `GET /orders/{id}`.
 */
export async function requeueFailedEventUsecase(eventId: string, errorMessage: string): Promise<void> {
  const event = await db.query.paymentEvents.findFirst({ where: eq(paymentEvents.id, eventId) });
  if (!event) return;
  const MAX = 5;
  if (event.attempts >= MAX) return;

  const backoffMs = Math.min(2 ** event.attempts * 30_000, 15 * 60_000);
  await db
    .update(paymentEvents)
    .set({
      status: "received",
      errorMessage: errorMessage.slice(0, 500),
      nextAttemptAt: new Date(Date.now() + backoffMs).toISOString(),
    })
    .where(eq(paymentEvents.id, eventId));
}

// ============================================================
// §22 — reconciliação
// ============================================================

/**
 * Relê no gateway as cobranças que ninguém confirmou. É a recuperação de
 * webhook perdido (spec §22) — e o caminho que preenche o QR que a doc oficial
 * não mostra de onde vem.
 *
 * Só `pending` e `processing`: uma cobrança já resolvida (`paid`, `failed`,
 * `canceled`) não é relida, porque o estado local já é o final e o gateway só
 * criaria tráfego. As `requested` de estorno entram para reconciliar o
 * estorno que o gateway pode ter perdido do mesmo jeito.
 */
export async function reconcilePendingPaymentsUsecase(limit = 20): Promise<{ checked: number; changed: number }> {
  const rows = await db
    .select()
    .from(payments)
    .where(and(inArray(payments.status, ["pending", "processing"]), or(eq(payments.provider, PROVIDER))))
    .orderBy(payments.createdAt)
    .limit(limit);

  let changed = 0;
  for (const row of rows) {
    if (!row.providerOrderId) continue; // criação que nem chegou no gateway
    try {
      const charge = await gateway().find(row.providerOrderId);
      if (!charge) continue;
      const atual = row.status as PaymentStatus;
      if (charge.status === atual) continue;
      if (!canMoveTo(atual, charge.status)) continue;
      await db.transaction((tx) => applyCharge(tx, row, charge));
      changed++;
    } catch (err) {
      // Falha de rede/gateway em UMA reconciliação não pode derrubar o ciclo:
      // as outras cobranças da fila precisam ser vistas, e o advisory lock do
      // worker garante que nada mais foi mexeu.
      console.warn(`[pagarme] falha ao reconciliar ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { checked: rows.length, changed };
}

/**
 * Guarda de transição na reconciliação. `applyCharge` grava direto (o webhook
 * chega na hora e não há estado intermediário confiável para checar), mas aqui a
 * leitura pode estar DIAS atrasada — e aplicar um `paid` numa cobrança já
 * `refunded` seria reverter dinheiro.
 */
function canMoveTo(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return false;
  if (from === "refunded" || from === "canceled" || from === "failed") return false;
  try {
    assertTransition(from, to);
    return true;
  } catch {
    return false;
  }
}

export { isFullyRefunded };