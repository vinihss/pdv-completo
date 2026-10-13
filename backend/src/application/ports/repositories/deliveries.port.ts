import type { EntityId, Page, PageRequest } from "../persistence.js";
export interface DeliverySummary { id: EntityId; orderId: EntityId; status: string; courierId: EntityId | null }
export interface DeliveryRepository {
  findById(id: EntityId): Promise<DeliverySummary | null>;
  findByOrder(orderId: EntityId): Promise<DeliverySummary | null>;
  list(page: PageRequest, filters?: { status?: string; courierId?: EntityId }): Promise<Page<DeliverySummary>>;
  assignCourier(id: EntityId, courierId: EntityId): Promise<DeliverySummary>;
  transition(id: EntityId, status: string): Promise<DeliverySummary>;
}
