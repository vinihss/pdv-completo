// Domain types for order refunds (Bloco 4 ROADMAP-CAIXA.md)

export type OrderRefundStatus = "requested" | "settled" | "failed";

export interface OrderRefund {
  id: string;
  orderId: string;
  orderPaymentId: string;
  amount: number;
  method: "cash" | "card" | "pix" | "other";
  reason: string;
  status: OrderRefundStatus;
  requestedBy: string;
  requestedAt: string;
  settledAt: string | null;
  notes: string | null;
  createdAt: string;
}
