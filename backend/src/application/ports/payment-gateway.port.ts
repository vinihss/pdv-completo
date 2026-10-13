import type { EntityId, JsonValue } from "./persistence.js";

export interface ChargeRequest {
  paymentId: EntityId;
  amountMinor: number;
  currency: string;
  method: string;
  idempotencyKey: string;
  metadata?: JsonValue;
}

export interface ChargeResult {
  provider: string;
  providerChargeId: string;
  status: string;
  raw?: JsonValue;
}

export interface RefundRequest {
  paymentId: EntityId;
  providerChargeId: string;
  amountMinor: number;
  idempotencyKey: string;
}

/** Contrato consumido por application; credenciais/HTTP/SDK ficam no adapter. */
export interface PaymentGateway {
  createCharge(input: ChargeRequest): Promise<ChargeResult>;
  refund(input: RefundRequest): Promise<{ providerRefundId: string; status: string }>;
}
