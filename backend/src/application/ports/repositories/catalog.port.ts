import type { EntityId, Page, PageRequest } from "../persistence.js";
export interface ProductSummary { id: EntityId; name: string; active: boolean }
export interface CategorySummary { id: EntityId; name: string; active: boolean }
export interface CatalogRepository {
  listProducts(page: PageRequest, filters?: { active?: boolean; search?: string }): Promise<Page<ProductSummary>>;
  findProduct(id: EntityId): Promise<ProductSummary | null>;
  saveProduct(input: Omit<ProductSummary, "id"> & { id?: EntityId }): Promise<ProductSummary>;
  listCategories(): Promise<CategorySummary[]>;
  saveCategory(input: Omit<CategorySummary, "id"> & { id?: EntityId }): Promise<CategorySummary>;
}
