import type { EntityId, JsonValue } from "../persistence.js";
export interface PaymentRecord { id: EntityId; orderId: EntityId; amountMinor: number; status: string; provider: string | null }
export interface PaymentRepository {
  findById(id: EntityId): Promise<PaymentRecord | null>;
  findByOrder(orderId: EntityId): Promise<PaymentRecord[]>;
  create(input: Omit<PaymentRecord, "id">): Promise<PaymentRecord>;
  transition(id: EntityId, status: string, providerData?: JsonValue): Promise<PaymentRecord>;
  recordProviderEvent(input: { provider: string; eventId: string; eventType: string; payload: JsonValue }): Promise<"recorded" | "duplicate">;
}
