import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import { orderRefunds } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import type { OrderRefundStatus } from "../../../domain/refund.js";
import type { Id, RefundRecord, RefundRepository } from "../../../application/ports/repositories.js";

// =====================================================================
// Estornos do balcão (order_refund — Bloco 4)
// =====================================================================

function toRefundRecord(r: typeof orderRefunds.$inferSelect): RefundRecord {
  return {
    id: r.id,
    orderId: r.orderId,
    orderPaymentId: r.orderPaymentId,
    amount: r.amount,
    method: r.method,
    reason: r.reason,
    status: r.status,
    requestedBy: r.requestedBy,
    requestedAt: r.requestedAt,
    settledAt: r.settledAt,
    notes: r.notes,
    createdAt: r.createdAt,
  };
}

export class PostgresRefundRepository implements RefundRepository {
  constructor(private readonly tx: Tx) {}

  /** Soma dos estornos ativos (`requested`+`settled`) de uma linha de pagamento. */
  async sumActiveByPayment(paymentId: Id): Promise<number> {
    const result = await this.tx
      .select({ total: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)` })
      .from(orderRefunds)
      .where(
        and(
          eq(orderRefunds.orderPaymentId, paymentId),
          inArray(orderRefunds.status, ["requested", "settled"]),
        ),
      );
    return result[0]?.total ?? 0;
  }

  async create(input: {
    id: Id;
    orderId: Id;
    orderPaymentId: Id;
    amount: number;
    method: "cash" | "card" | "pix" | "other";
    reason: string;
    status: string;
    requestedBy: Id;
    requestedAt: string;
    settledAt: string | null;
    notes: string | null;
  }): Promise<RefundRecord> {
    const [row] = await this.tx
      .insert(orderRefunds)
      .values({
        id: input.id,
        orderId: input.orderId,
        orderPaymentId: input.orderPaymentId,
        amount: input.amount,
        method: input.method,
        reason: input.reason,
        status: input.status as OrderRefundStatus,
        requestedBy: input.requestedBy,
        requestedAt: input.requestedAt,
        settledAt: input.settledAt,
        notes: input.notes,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "orderPaymentId" });
    return toRefundRecord(row);
  }

  /** `GET /orders/:id/refunds` — ordem de criação. */
  async listByOrder(orderId: Id): Promise<RefundRecord[]> {
    const rows = await this.tx
      .select()
      .from(orderRefunds)
      .where(eq(orderRefunds.orderId, orderId))
      .orderBy(asc(orderRefunds.createdAt));
    return rows.map(toRefundRecord);
  }
}

