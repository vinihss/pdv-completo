import { eq, and, sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "../../infra/db/client.js";
import { orderSettlements, orders } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { round2 } from "../../domain/money.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";

// ============================================================================
// Settlement iFood (Bloco 5 ROADMAP-CAIXA.md)
// ============================================================================
//
// Settlement de marketplace: separa receita bruta de repasse líquido.
// Um settlement por pedido (UNIQUE em order_id). Para pedidos iFood, o payout_amount
// é o que efetivamente a loja recebe após comissões e taxas. Para pedidos de outros
// canais, o settlement é opcional (fallback: usar orders.total).
//
// Lógica:
// - registerSettlementUsecase: valida pedido fechado, calcula payout, insere
// - markSettledUsecase: marca settlement como 'paid' (repasse confirmado)
// - listSettlementsUsecase: lista com filtros opcionais (channel, status, data)
// - getSettlementByOrderIdUsecase: busca settlement por orderId
//
// Validações:
// - Pedido deve estar fechado (status = 'closed')
// - Não pode haver settlement duplicado (UNIQUE constraint em order_id)
// - payoutAmount = grossAmount - commissionAmount - marketplaceFee - deliveryFeeSubsidy
//
// Idempotência: comIdempotency com correlationId (padrão do repo).
// ============================================================================

export interface RegisterSettlementInput {
  orderId: string;
  channel: string;
  grossAmount: number;
  commissionAmount: number;
  marketplaceFee?: number;
  deliveryFeeSubsidy?: number;
  payoutAmount?: number;  // opcional: se não informado, calcula automaticamente
  payoutExpectedAt?: string;
  externalRef?: string;
  notes?: string;
  userId: string;
}

export async function registerSettlementUsecase(input: RegisterSettlementInput) {
  return await db.transaction(async (tx) => {
    // 1. Buscar pedido
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1);

    if (!order) {
      throw Errors.notFound("Pedido");
    }

    // 2. Validar: pedido fechado
    if (order.status !== "closed") {
      throw Errors.settlementOrderNotClosed();
    }

    // 3. Validar: não existe settlement para este pedido (UNIQUE constraint)
    const [existing] = await tx
      .select()
      .from(orderSettlements)
      .where(eq(orderSettlements.orderId, input.orderId))
      .limit(1);

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

    // 5. Criar settlement
    const now = new Date().toISOString();
    const [settlement] = await tx
      .insert(orderSettlements)
      .values({
        id: crypto.randomUUID(),
        orderId: input.orderId,
        channel: input.channel,
        grossAmount: input.grossAmount,
        commissionAmount: input.commissionAmount,
        marketplaceFee,
        deliveryFeeSubsidy,
        payoutAmount,
        payoutStatus: "pending",
        payoutExpectedAt: input.payoutExpectedAt ?? null,
        externalRef: input.externalRef ?? null,
        notes: input.notes ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // 6. Log de auditoria
    await logAction(tx, input.userId, "settlement.create", input.orderId, {
      settlementId: settlement.id,
      channel: input.channel,
      grossAmount: input.grossAmount,
      commissionAmount: input.commissionAmount,
      marketplaceFee,
      deliveryFeeSubsidy,
      payoutAmount,
    });

    // 7. Event para realtime (room alerts)
    await enqueueEvent(tx, "alerts", "settlement.created", {
      settlementId: settlement.id,
      orderId: input.orderId,
      channel: input.channel,
      payoutAmount,
    });

    return settlement;
  });
}

// ============================================================================
// Marcar settlement como recebido (pago)
// ============================================================================

export interface MarkSettledInput {
  settlementId: string;
  payoutSettledAt: string;
  userId: string;
}

export async function markSettledUsecase(input: MarkSettledInput) {
  return await db.transaction(async (tx) => {
    // 1. Buscar settlement
    const [settlement] = await tx
      .select()
      .from(orderSettlements)
      .where(eq(orderSettlements.id, input.settlementId))
      .limit(1);

    if (!settlement) {
      throw Errors.notFound("Settlement");
    }

    // 2. Atualizar status para 'paid'
    const now = new Date().toISOString();
    const [updated] = await tx
      .update(orderSettlements)
      .set({
        payoutStatus: "paid",
        payoutSettledAt: input.payoutSettledAt,
        updatedAt: now,
      })
      .where(eq(orderSettlements.id, input.settlementId))
      .returning();

    // 3. Log de auditoria
    await logAction(tx, input.userId, "settlement.settle", settlement.orderId, {
      settlementId: input.settlementId,
      payoutSettledAt: input.payoutSettledAt,
    });

    // 4. Event para realtime (room alerts)
    await enqueueEvent(tx, "alerts", "settlement.settled", {
      settlementId: input.settlementId,
      orderId: settlement.orderId,
      payoutSettledAt: input.payoutSettledAt,
    });

    return updated;
  });
}

// ============================================================================
// Listar settlements com filtros opcionais
// ============================================================================

export interface ListSettlementsInput {
  channel?: string;
  payoutStatus?: string;
  from?: string;
  to?: string;
}

export async function listSettlementsUsecase(input: ListSettlementsInput = {}) {
  const conditions: SQL<unknown>[] = [];

  if (input.channel) {
    conditions.push(eq(orderSettlements.channel, input.channel));
  }

  if (input.payoutStatus) {
    conditions.push(eq(orderSettlements.payoutStatus, input.payoutStatus as any));
  }

  if (input.from) {
    conditions.push(sql`${orderSettlements.createdAt} >= ${input.from}`);
  }

  if (input.to) {
    conditions.push(sql`${orderSettlements.createdAt} <= ${input.to}T23:59:59.999Z`);
  }

  const settlements = await db
    .select()
    .from(orderSettlements)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(orderSettlements.createdAt);

  return settlements;
}

// ============================================================================
// Buscar settlement por orderId
// ============================================================================

export async function getSettlementByOrderIdUsecase(orderId: string) {
  const [settlement] = await db
    .select()
    .from(orderSettlements)
    .where(eq(orderSettlements.orderId, orderId))
    .limit(1);

  return settlement ?? null;
}
