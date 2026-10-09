import { eq, and, sql } from "drizzle-orm";
import { db, type Tx } from "../../infra/db/client.js";
import {
  orderRefunds,
  orderPayments,
  orders,
  cashDrawerMovements,
} from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { round2 } from "../../domain/money.js";
import type { OrderRefundStatus } from "../../domain/refund.js";
import { findOpenDrawerTxForUpdate } from "../cash-flow/cash-flow.usecases.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";

// ============================================================================
// Estorno de pagamentos (Bloco 4 ROADMAP-CAIXA.md)
// ============================================================================
//
// Estorno rastreável: venda estornada vira linha negativa no relatório, não
// desaparece. Diferente de payment_refund (Pagar.me gateway) — aqui é o
// estorno manual no balcão.
//
// Lógica:
// 1. Dinheiro (cash): exige gaveta aberta, gera sangria automática com
//    ref_order_id, cria order_refund com status='settled'.
// 2. Pix/cartão/outros: cria order_refund com status='requested' (futuro:
//    integração com Pagar.me). Sem sangria automática.
//
// Validações:
// - Pagamento deve estar confirmado (confirmed=true)
// - Valor do estorno não pode exceder o valor do pagamento
// - Soma dos estornos existentes + valor atual <= valor do pagamento
// - Estorno em dinheiro exige caixa aberto (sangria automática)
//
// Idempotência: comIdempotency com correlationId (padrão do repo).
// ============================================================================

export interface RefundOrderPaymentInput {
  orderId: string;
  paymentId: string;
  amount: number;
  reason: string;
  userId: string;
  notes?: string;
}

export async function refundOrderPaymentUsecase(input: RefundOrderPaymentInput) {
  return await db.transaction(async (tx) => {
    // 1. Buscar pagamento pelo paymentId + orderId
    const [payment] = await tx
      .select()
      .from(orderPayments)
      .where(and(eq(orderPayments.id, input.paymentId), eq(orderPayments.orderId, input.orderId)))
      .limit(1);

    if (!payment) {
      throw Errors.notFound("Pagamento");
    }

    // 2. Validar: pagamento confirmado
    if (!payment.confirmed) {
      throw Errors.refundPaymentNotConfirmed();
    }

    // 3. Validar: amount <= payment.amount
    if (input.amount > payment.amount) {
      throw Errors.refundExceedsPayment(input.amount, payment.amount);
    }

    // 4. Validar: soma dos refunds já existentes + amount atual <= payment.amount
    const existingRefunds = await tx
      .select({ total: sql<number>`COALESCE(SUM(${orderRefunds.amount}), 0)` })
      .from(orderRefunds)
      .where(
        and(
          eq(orderRefunds.orderPaymentId, input.paymentId),
          sql`${orderRefunds.status} IN ('requested', 'settled')`
        )
      );

    const existingTotal = existingRefunds[0]?.total ?? 0;
    const availableForRefund = round2(payment.amount - existingTotal);

    if (input.amount > availableForRefund) {
      throw Errors.refundExceedsPayment(input.amount, availableForRefund);
    }

    // 5. Processar estorno conforme método
    const isCash = payment.method === "cash";
    let status: OrderRefundStatus = "requested";
    let settledAt: string | null = null;

    if (isCash) {
      // Dinheiro: exige gaveta aberta, gera sangria automática
      const drawer = await findOpenDrawerTxForUpdate(tx);
      if (!drawer) {
        throw Errors.cashDrawerNotOpen();
      }

      // Gerar sangria automática com ref_order_id
      await tx.insert(cashDrawerMovements).values({
        drawerId: drawer.id,
        type: "sangria",
        amount: input.amount,
        note: `Estorno: ${input.reason}`,
        refOrderId: input.orderId,
        createdBy: input.userId,
      });

      status = "settled";
      settledAt = new Date().toISOString();
    }
    // Pix/cartão/outros: status='requested', settledAt=null
    // (futuro: integração com Pagar.me)

    // 6. Criar order_refund
    const [refund] = await tx
      .insert(orderRefunds)
      .values({
        id: crypto.randomUUID(),
        orderId: input.orderId,
        orderPaymentId: input.paymentId,
        amount: input.amount,
        method: payment.method,
        reason: input.reason,
        status,
        requestedBy: input.userId,
        requestedAt: new Date().toISOString(),
        settledAt,
        notes: input.notes ?? null,
      })
      .returning();

    // 7. Log de auditoria
    await logAction(
      tx,
      input.userId,
      "refund.create",
      input.orderId,
      {
        refundId: refund.id,
        paymentId: input.paymentId,
        amount: input.amount,
        method: payment.method,
        status,
        reason: input.reason,
      }
    );

    // 8. Event para realtime (room cash-drawer para cash, alerts para outros)
    const drawerId = isCash ? (await findOpenDrawerTxForUpdate(tx))?.id : null;
    if (isCash && drawerId) {
      await enqueueEvent(tx, "cash-drawer", "cash-drawer.refund", {
        refundId: refund.id,
        orderId: input.orderId,
        amount: input.amount,
        method: payment.method,
        reason: input.reason,
        status,
        drawerId,
      });
    } else {
      await enqueueEvent(tx, "alerts", "refund.created", {
        refundId: refund.id,
        orderId: input.orderId,
        amount: input.amount,
        method: payment.method,
        reason: input.reason,
        status,
      });
    }

    return refund;
  });
}

// ============================================================================
// Listar estornos de um pedido
// ============================================================================

export async function listOrderRefundsUsecase(orderId: string) {
  const refunds = await db
    .select()
    .from(orderRefunds)
    .where(eq(orderRefunds.orderId, orderId))
    .orderBy(orderRefunds.createdAt);

  return refunds;
}

// ============================================================================
// Helper: soma de estornos settled para relatório
// ============================================================================

export async function sumSettledRefundsForOrder(tx: Tx, orderId: string): Promise<number> {
  const result = await tx
    .select({ total: sql<number>`COALESCE(SUM(${orderRefunds.amount}), 0)` })
    .from(orderRefunds)
    .where(and(eq(orderRefunds.orderId, orderId), eq(orderRefunds.status, "settled")));

  return round2(result[0]?.total ?? 0);
}

export async function sumSettledRefundsForPayment(tx: Tx, paymentId: string): Promise<number> {
  const result = await tx
    .select({ total: sql<number>`COALESCE(SUM(${orderRefunds.amount}), 0)` })
    .from(orderRefunds)
    .where(and(eq(orderRefunds.orderPaymentId, paymentId), eq(orderRefunds.status, "settled")));

  return round2(result[0]?.total ?? 0);
}

// ============================================================================
// Helper: total de estornos settled no período (para relatório agregado)
// ============================================================================

export async function sumSettledRefundsBetween(
  tx: Tx,
  from: string,
  to: string
): Promise<number> {
  const result = await tx
    .select({ total: sql<number>`COALESCE(SUM(${orderRefunds.amount}), 0)` })
    .from(orderRefunds)
    .where(
      and(
        eq(orderRefunds.status, "settled"),
        sql`${orderRefunds.settledAt} >= ${from}`,
        sql`${orderRefunds.settledAt} <= ${to}`
      )
    );

  return round2(result[0]?.total ?? 0);
}
