/**
 * Port de fornecedores (`supplier`) — compras.
 *
 * Contrato CONGELADO: os use cases falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/supplier.repository.ts`) traduz para
 * Drizzle/schema.
 */
import type { Id, Page } from "../../ports/repositories/shared.js";

/**
 * ADIÇÃO (Onda financeiro — compras): fornecedor (`supplier`). O trim/merge dos
 * campos é do use case; o adapter grava o valor resolvido.
 */
export interface SupplierRecord {
  id: Id;
  name: string;
  phone: string | null;
  taxId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierRepository {
  /** Lista (opcionalmente só ativos) `name ASC` + total. */
  list(query: { activeOnly?: boolean; limit: number; offset: number }): Promise<Page<SupplierRecord>>;
  findById(id: Id): Promise<SupplierRecord | null>;
  create(input: { name: string; phone?: string | null; taxId?: string | null }): Promise<SupplierRecord>;
  /** UPDATE dos campos JÁ resolvidos pelo use case (merge + trim são domínio). */
  update(
    id: Id,
    input: { name: string; phone: string | null; taxId: string | null; active: boolean },
  ): Promise<SupplierRecord>;
}
