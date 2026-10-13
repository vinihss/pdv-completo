/**
 * Port de compras (`purchase`/`purchase_item`) — custo médio móvel.
 *
 * Contrato CONGELADO: os use cases falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/purchase.repository.ts`) traduz para
 * Drizzle/schema.
 */
import type { Id, Page } from "../../ports/repositories/shared.js";

export interface PurchaseRecord {
  id: Id;
  supplierId: Id | null;
  invoiceNumber: string | null;
  issuedOn: string | null;
  note: string | null;
  total: number;
  createdBy: Id;
  createdAt: string;
}

/** ADIÇÃO (Onda financeiro — compras): linha da listagem (`GET /purchases`). */
export interface PurchaseListItemRecord {
  id: Id;
  invoiceNumber: string | null;
  issuedOn: string | null;
  supplierId: Id | null;
  supplierName: string | null;
  note: string | null;
  total: number;
  createdByName: string | null;
  createdAt: string;
  itemCount: number;
}

/** ADIÇÃO (Onda financeiro — compras): cabeçalho do detalhe (`GET /purchases/:id`). */
export interface PurchaseDetailRecord {
  id: Id;
  invoiceNumber: string | null;
  issuedOn: string | null;
  note: string | null;
  total: number;
  supplierId: Id | null;
  supplierName: string | null;
  createdByName: string | null;
  createdAt: string;
}

/** ADIÇÃO (Onda financeiro — compras): linha do detalhe, com nome do produto. */
export interface PurchaseItemViewRecord {
  id: Id;
  productId: Id;
  productName: string | null;
  quantity: number;
  unitCost: number;
  lineTotal: number;
  batchNo: string | null;
  expiryDate: string | null;
}

export interface PurchaseRepository {
  findById(id: Id): Promise<PurchaseRecord | null>;
  create(input: { supplierId?: Id | null; actorId: Id }): Promise<PurchaseRecord>;
  addItem(input: { purchaseId: Id; productId: Id; quantity: number; unitCost: number }): Promise<void>;
  finalize(id: Id): Promise<void>;

  // ---------- ADIÇÃO (Onda financeiro — compras) ----------
  /** INSERT do documento completo (`createPurchaseUsecase`) com todos os cabeçalhos. */
  createDocument(input: {
    supplierId?: Id | null;
    invoiceNumber?: string | null;
    issuedOn?: string | null;
    note?: string | null;
    total: number;
    actorId: Id;
  }): Promise<PurchaseRecord>;
  /** INSERT da linha (`lineTotal` já arredondado pelo use case). Devolve id + lineTotal. */
  insertItem(input: {
    purchaseId: Id;
    productId: Id;
    quantity: number;
    unitCost: number;
    lineTotal: number;
    batchNo?: string | null;
    expiryDate?: string | null;
    actorId: Id;
  }): Promise<{ id: Id; lineTotal: number }>;
  /** Listagem (`createdAt DESC`, fornecedor/usuário resolvidos, contagem de linhas) + total. */
  list(query: { limit: number; offset: number }): Promise<Page<PurchaseListItemRecord>>;
  /** Cabeçalho do detalhe (fornecedor/usuário resolvidos) ou null. */
  findDetail(id: Id): Promise<PurchaseDetailRecord | null>;
  /** Linhas do documento com nome do produto (`products.name ASC, purchase_item.seq ASC`). */
  listItems(id: Id): Promise<PurchaseItemViewRecord[]>;
}
