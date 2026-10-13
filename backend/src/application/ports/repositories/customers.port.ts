import type { EntityId, Page, PageRequest } from "../persistence.js";
export interface CustomerSummary { id: EntityId; name: string; phone: string | null }
export interface CustomerRepository {
  findById(id: EntityId): Promise<CustomerSummary | null>;
  findByPhone(phone: string): Promise<CustomerSummary | null>;
  list(page: PageRequest, search?: string): Promise<Page<CustomerSummary>>;
  save(input: Omit<CustomerSummary, "id"> & { id?: EntityId }): Promise<CustomerSummary>;
  delete(id: EntityId): Promise<void>;
}
