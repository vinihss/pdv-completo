// Domain types for order settlements (Bloco 5 ROADMAP-CAIXA.md)

export type SettlementPayoutStatus = "pending" | "paid" | "failed";

export interface OrderSettlement {
  id: string;
  orderId: string;
  channel: string;
  grossAmount: number;
  commissionAmount: number;
  marketplaceFee: number;
  deliveryFeeSubsidy: number;
  payoutAmount: number;
  payoutStatus: SettlementPayoutStatus;
  payoutExpectedAt: string | null;
  payoutSettledAt: string | null;
  externalRef: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}
