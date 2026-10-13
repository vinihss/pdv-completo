import type { EntityId } from "../persistence.js";
export interface StockBalance { productId: EntityId; quantity: number }
export interface StockRepository {
  getBalance(productId: EntityId): Promise<StockBalance>;
  recordMovement(input: { productId: EntityId; quantityDelta: number; reason: string; referenceId?: EntityId }): Promise<void>;
  reserveForOrder(orderId: EntityId): Promise<void>;
  releaseForOrder(orderId: EntityId): Promise<void>;
}
