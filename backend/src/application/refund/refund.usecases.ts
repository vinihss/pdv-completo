// ============================================================================
// Estorno de pagamentos (Bloco 4 ROADMAP-CAIXA.md)
// ============================================================================
//
// Estorno rastreável: a venda estornada vira linha negativa no relatório, nunca
// desaparece. Distinto do `payment_refund` do gateway Pagar.me.
//
// Regras (todas na MESMA transação):
//   - pagamento precisa existir e ser do pedido informado;
//   - pagamento confirmado;
//   - amount <= payment.amount e amount <= (payment.amount - estornos ativos);
//   - estorno em dinheiro exige gaveta aberta e grava sangria automática;
//   - audit + outbox no mesmo commit da escrita de domínio.
//
// ONDA financeiro: este arquivo não toca em Drizzle/infra. Toda leitura/escrita
// passa pelos ports do `TenantSession` (orders/refunds/cashFlow) e o
// `audit`/`outbox` saem pela mesma sessão. A régua e os payloads são os do use
// case original.
//
// Idempotência: `withIdempotency` com correlationId (padrão do repo, na rota).
// ============================================================================

import { Errors } from "../../domain/errors.js";
import { round2 } from "../../domain/money.js";
import type { TenantContext } from "../ports/tenant-context.js";
import type { TenantUnitOfWork } from "../ports/unit-of-work.js";

export interface RefundOrderPaymentInput {
  orderId: string;
  paymentId: string;
  amount: number;
  reason: string;
  userId: string;
  notes?: string;
}

export interface RefundUsecasesDeps {
  uow: TenantUnitOfWork;
  tenant: () => TenantContext;
}

export function createRefundUsecases(deps: RefundUsecasesDeps) {
  return {
    // ---------- POST /orders/:id/payments/:paymentId/refunds ----------
    async refundOrderPaymentUsecase(input: RefundOrderPaymentInput) {
      return deps.uow.run(deps.tenant(), async (session) => {
        // 1. Buscar pagamento pelo paymentId e conferir que é do pedido informado
        const payment = await session.orders.findPaymentLine(input.paymentId);
        if (!payment || payment.orderId !== input.orderId) {
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

        // 4. Validar: soma dos estornos ativos + amount atual <= payment.amount
        const existingTotal = await session.refunds.sumActiveByPayment(input.paymentId);
        const availableForRefund = round2(payment.amount - existingTotal);
        if (input.amount > availableForRefund) {
          throw Errors.refundExceedsPayment(input.amount, availableForRefund);
        }

        // 5. Dinheiro: gaveta aberta + sangria automática (mesma trava de linha
        // de `findOpenDrawerTxForUpdate`); os demais métodos ficam 'requested'
        // (futuro: integração com Pagar.me).
        let drawer: { id: string; openedAt: string } | null = null;
        let status = "requested";
        let settledAt: string | null = null;
        if (payment.method === "cash") {
          drawer = await session.cashFlow.findOpenForUpdate();
          if (!drawer) {
            throw Errors.cashDrawerNotOpen();
          }
          await session.cashFlow.recordMovement({
            drawerId: drawer.id,
            actorId: input.userId,
            type: "sangria",
            amount: input.amount,
            note: `Estorno: ${input.reason}`,
            refOrderId: input.orderId,
          });
          status = "settled";
          settledAt = new Date().toISOString();
        }

        // 6. Criar order_refund
        const refund = await session.refunds.create({
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
        });

        // 7. Log de auditoria
        await session.audit.record({
          actorId: input.userId,
          action: "refund.create",
          orderId: input.orderId,
          details: {
            refundId: refund.id,
            paymentId: input.paymentId,
            amount: input.amount,
            method: payment.method,
            status,
            reason: input.reason,
          },
        });

        // 8. Event para realtime (room cash-drawer para cash, alerts para outros)
        if (drawer) {
          await session.outbox.enqueue({
            room: "cash-drawer",
            type: "cash-drawer.refund",
            aggregateId: refund.id,
            payload: {
              refundId: refund.id,
              orderId: input.orderId,
              amount: input.amount,
              method: payment.method,
              reason: input.reason,
              status,
              drawerId: drawer.id,
            },
          });
        } else {
          await session.outbox.enqueue({
            room: "alerts",
            type: "refund.created",
            aggregateId: refund.id,
            payload: {
              refundId: refund.id,
              orderId: input.orderId,
              amount: input.amount,
              method: payment.method,
              reason: input.reason,
              status,
            },
          });
        }

        return refund;
      });
    },

    // ---------- GET /orders/:id/refunds ----------
    async listOrderRefundsUsecase(orderId: string) {
      return deps.uow.run(deps.tenant(), (session) => session.refunds.listByOrder(orderId));
    },
  };
}

export type RefundUsecases = ReturnType<typeof createRefundUsecases>;
