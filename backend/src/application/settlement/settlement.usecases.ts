// ============================================================================
// Settlement iFood (Bloco 5 ROADMAP-CAIXA.md)
// ============================================================================
//
// Settlement de marketplace: separa receita bruta de repasse líquido. Um
// settlement por pedido (UNIQUE em order_id). Para pedidos iFood, o
// payout_amount é o que a loja efetivamente recebe após comissões e taxas.
// Para outros canais, o settlement é opcional (fallback: usar orders.total).
//
// Use cases:
//   - registerSettlementUsecase: valida pedido fechado, calcula payout, insere;
//   - markSettledUsecase: marca settlement como 'paid' (repasse confirmado);
//   - listSettlementsUsecase: lista com filtros opcionais (channel/status/data);
//   - getSettlementByOrderIdUsecase: busca settlement por orderId.
//
// Regras:
//   - pedido deve estar fechado (status = 'closed');
//   - não pode haver settlement duplicado (UNIQUE constraint em order_id);
//   - payoutAmount = gross - commission - marketplaceFee - deliveryFeeSubsidy.
//
// ONDA financeiro: este arquivo não toca em Drizzle/infra. As leituras/escritas
// passam pelos ports do `TenantSession` (orders/settlements) e o
// `audit`/`outbox` saem na MESMA transação do UoW. Payloads e régua originais.
//
// Idempotência: `withIdempotency` com correlationId (padrão do repo, na rota).
// ============================================================================

import { Errors } from "../../domain/errors.js";
import { round2 } from "../../domain/money.js";
import type { TenantContext } from "../ports/tenant-context.js";
import type { TenantUnitOfWork } from "../ports/unit-of-work.js";

export interface RegisterSettlementInput {
  orderId: string;
  channel: string;
  grossAmount: number;
  commissionAmount: number;
  marketplaceFee?: number;
  deliveryFeeSubsidy?: number;
  /** Opcional: se não informado, calcula automaticamente. */
  payoutAmount?: number;
  payoutExpectedAt?: string;
  externalRef?: string;
  notes?: string;
  userId: string;
}

export interface MarkSettledInput {
  settlementId: string;
  payoutSettledAt: string;
  userId: string;
}

export interface ListSettlementsInput {
  channel?: string;
  payoutStatus?: string;
  from?: string;
  to?: string;
}

export interface SettlementUsecasesDeps {
  uow: TenantUnitOfWork;
  tenant: () => TenantContext;
}

export function createSettlementUsecases(deps: SettlementUsecasesDeps) {
  return {
    // ---------- POST /settlements ----------
    async registerSettlementUsecase(input: RegisterSettlementInput) {
      return deps.uow.run(deps.tenant(), async (session) => {
        // 1. Buscar pedido
        const order = await session.orders.findRow(input.orderId);
        if (!order) {
          throw Errors.notFound("Pedido");
        }

        // 2. Validar: pedido fechado
        if (order.status !== "closed") {
          throw Errors.settlementOrderNotClosed();
        }

        // 3. Validar: não existe settlement para este pedido (UNIQUE constraint)
        const existing = await session.settlements.findByOrderId(input.orderId);
        if (existing) {
          throw Errors.settlementAlreadyExists();
        }

        // 4. Calcular payoutAmount se não informado
        const marketplaceFee = input.marketplaceFee ?? 0;
        const deliveryFeeSubsidy = input.deliveryFeeSubsidy ?? 0;
        const payoutAmount =
          input.payoutAmount ??
          round2(input.grossAmount - input.commissionAmount - marketplaceFee - deliveryFeeSubsidy);

        if (payoutAmount < 0) {
          throw Errors.validationFailed({
            message: "payoutAmount não pode ser negativo",
            payoutAmount,
          });
        }

        // 5. Criar settlement (payout_status inicial 'pending' no adapter)
        const now = new Date().toISOString();
        const settlement = await session.settlements.create({
          id: crypto.randomUUID(),
          orderId: input.orderId,
          channel: input.channel,
          grossAmount: input.grossAmount,
          commissionAmount: input.commissionAmount,
          marketplaceFee,
          deliveryFeeSubsidy,
          payoutAmount,
          payoutExpectedAt: input.payoutExpectedAt ?? null,
          externalRef: input.externalRef ?? null,
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
        });

        // 6. Log de auditoria
        await session.audit.record({
          actorId: input.userId,
          action: "settlement.create",
          orderId: input.orderId,
          details: {
            settlementId: settlement.id,
            channel: input.channel,
            grossAmount: input.grossAmount,
            commissionAmount: input.commissionAmount,
            marketplaceFee,
            deliveryFeeSubsidy,
            payoutAmount,
          },
        });

        // 7. Event para realtime (room alerts)
        await session.outbox.enqueue({
          room: "alerts",
          type: "settlement.created",
          aggregateId: settlement.id,
          payload: {
            settlementId: settlement.id,
            orderId: input.orderId,
            channel: input.channel,
            payoutAmount,
          },
        });

        return settlement;
      });
    },

    // ---------- PATCH /settlements/:id/settle ----------
    async markSettledUsecase(input: MarkSettledInput) {
      return deps.uow.run(deps.tenant(), async (session) => {
        // 1. Buscar settlement
        const settlement = await session.settlements.findById(input.settlementId);
        if (!settlement) {
          throw Errors.notFound("Settlement");
        }

        // 2. Atualizar status para 'paid'
        const updated = await session.settlements.markSettled(input.settlementId, {
          payoutSettledAt: input.payoutSettledAt,
          updatedAt: new Date().toISOString(),
        });

        // 3. Log de auditoria
        await session.audit.record({
          actorId: input.userId,
          action: "settlement.settle",
          orderId: settlement.orderId,
          details: {
            settlementId: input.settlementId,
            payoutSettledAt: input.payoutSettledAt,
          },
        });

        // 4. Event para realtime (room alerts)
        await session.outbox.enqueue({
          room: "alerts",
          type: "settlement.settled",
          aggregateId: input.settlementId,
          payload: {
            settlementId: input.settlementId,
            orderId: settlement.orderId,
            payoutSettledAt: input.payoutSettledAt,
          },
        });

        return updated;
      });
    },

    // ---------- GET /settlements ----------
    async listSettlementsUsecase(input: ListSettlementsInput = {}) {
      return deps.uow.run(deps.tenant(), (session) => session.settlements.list(input));
    },

    // ---------- GET /settlements/by-order/:orderId ----------
    async getSettlementByOrderIdUsecase(orderId: string) {
      return deps.uow.run(deps.tenant(), (session) => session.settlements.findByOrderId(orderId));
    },
  };
}

export type SettlementUsecases = ReturnType<typeof createSettlementUsecases>;
