import type { EntityId, Page, PageRequest } from "../persistence.js";
export interface PurchaseSummary { id: EntityId; supplierId: EntityId | null; totalMinor: number; status: string }
export interface PurchaseRepository {
  findById(id: EntityId): Promise<PurchaseSummary | null>;
  list(page: PageRequest): Promise<Page<PurchaseSummary>>;
  create(input: { supplierId?: EntityId | null; actorId: EntityId }): Promise<PurchaseSummary>;
  addItem(input: { purchaseId: EntityId; productId: EntityId; quantity: number; unitCostMinor: number }): Promise<void>;
  finalize(id: EntityId): Promise<PurchaseSummary>;
}
