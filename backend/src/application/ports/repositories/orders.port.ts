import type { EntityId, Page, PageRequest } from "../persistence.js";
export interface OrderSummary { id: EntityId; status: string; totalMinor: number; tableId: EntityId | null }
export interface OrderRepository {
  findById(id: EntityId): Promise<OrderSummary | null>;
  findOpenForTable(tableId: EntityId): Promise<OrderSummary | null>;
  listOpen(page: PageRequest): Promise<Page<OrderSummary>>;
  create(input: { tableId?: EntityId | null; customerId?: EntityId | null; channel: string }): Promise<OrderSummary>;
  updateStatus(id: EntityId, status: string): Promise<OrderSummary>;
  delete(id: EntityId): Promise<void>;
}
