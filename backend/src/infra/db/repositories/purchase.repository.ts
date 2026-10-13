import { count, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import { products, purchaseItems, purchases, suppliers, users } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import { notImplemented } from "./shared.js";
import type {
  Id,
  Page,
  PurchaseDetailRecord,
  PurchaseItemViewRecord,
  PurchaseListItemRecord,
  PurchaseRecord,
  PurchaseRepository,
} from "../../../application/ports/repositories.js";

// =====================================================================
// Compras
// =====================================================================

function toPurchaseRecord(p: typeof purchases.$inferSelect): PurchaseRecord {
  return {
    id: p.id,
    supplierId: p.supplierId,
    invoiceNumber: p.invoiceNumber,
    issuedOn: p.issuedOn,
    note: p.note,
    total: p.total,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
  };
}

export class PostgresPurchaseRepository implements PurchaseRepository {
  constructor(private readonly tx: Tx) {}

  /** Documento (sem linhas): o detalhe com itens continua no use case. */
  async findById(id: Id): Promise<PurchaseRecord | null> {
    const row = await this.tx.query.purchases.findFirst({ where: eq(purchases.id, id) });
    return row ? toPurchaseRecord(row) : null;
  }

  /** Cria o documento vazio (`total` = 0 até as linhas entrarem). */
  async create(input: { supplierId?: Id | null; actorId: Id }): Promise<PurchaseRecord> {
    const [row] = await this.tx
      .insert(purchases)
      .values({ supplierId: input.supplierId ?? null, createdBy: input.actorId })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "supplierId" });
    return toPurchaseRecord(row);
  }

  // TODO(onda de purchase): a linha real valida produto/rastreamento, recalcula
  // `total`, grava movimento `purchase` no ledger (unit_cost = valoração da
  // média móvel) e emite outbox `purchase.received` — transação única em
  // `createPurchaseUsecase`. Insert parcial aqui daria uma compra "meio
  // registrada"; implementar tudo de uma vez.
  async addItem(_input: { purchaseId: Id; productId: Id; quantity: number; unitCost: number }): Promise<void> {
    return notImplemented("PurchaseRepository.addItem — linha + ledger + média móvel (ver TODO no código)");
  }

  // TODO(onda de purchase): "finalizar" não existe como passo separado hoje
  // (documento + linhas + ledger são atômicos em `createPurchaseUsecase`).
  async finalize(_id: Id): Promise<void> {
    return notImplemented("PurchaseRepository.finalize — semântica a definir na onda de purchase");
  }

  // ---------- ADIÇÃO (Onda financeiro — compras) ----------

  /** INSERT do documento com todos os cabeçalhos (`createPurchaseUsecase`). */
  async createDocument(input: {
    supplierId?: Id | null;
    invoiceNumber?: string | null;
    issuedOn?: string | null;
    note?: string | null;
    total: number;
    actorId: Id;
  }): Promise<PurchaseRecord> {
    const [row] = await this.tx
      .insert(purchases)
      .values({
        supplierId: input.supplierId ?? null,
        invoiceNumber: input.invoiceNumber ?? null,
        issuedOn: input.issuedOn ?? null,
        note: input.note ?? null,
        total: input.total,
        createdBy: input.actorId,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "supplierId" });
    return toPurchaseRecord(row);
  }

  /** INSERT de uma linha do documento (`lineTotal` já arredondado pelo use case). */
  async insertItem(input: {
    purchaseId: Id;
    productId: Id;
    quantity: number;
    unitCost: number;
    lineTotal: number;
    batchNo?: string | null;
    expiryDate?: string | null;
    actorId: Id;
  }): Promise<{ id: Id; lineTotal: number }> {
    const [row] = await this.tx
      .insert(purchaseItems)
      .values({
        purchaseId: input.purchaseId,
        productId: input.productId,
        quantity: input.quantity,
        unitCost: input.unitCost,
        lineTotal: input.lineTotal,
        batchNo: input.batchNo ?? null,
        expiryDate: input.expiryDate ?? null,
        createdBy: input.actorId,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "purchaseId" });
    return { id: row.id, lineTotal: row.lineTotal };
  }

  /** `GET /purchases` — fornecedor/usuário resolvidos + contagem de linhas, `createdAt DESC` + total. */
  async list(query: { limit: number; offset: number }): Promise<Page<PurchaseListItemRecord>> {
    const rows = await this.tx
      .select({
        id: purchases.id,
        invoiceNumber: purchases.invoiceNumber,
        issuedOn: purchases.issuedOn,
        supplierId: purchases.supplierId,
        supplierName: suppliers.name,
        note: purchases.note,
        total: purchases.total,
        createdByName: users.name,
        createdAt: purchases.createdAt,
        itemCount: sql<number>`count(${purchaseItems.id})::int`,
      })
      .from(purchases)
      .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
      .leftJoin(users, eq(users.id, purchases.createdBy))
      .leftJoin(purchaseItems, eq(purchaseItems.purchaseId, purchases.id))
      .groupBy(purchases.id)
      .orderBy(desc(purchases.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const totalRow = await this.tx.select({ count: count() }).from(purchases);
    return { data: rows, total: Number(totalRow[0]?.count ?? rows.length) };
  }

  /** `GET /purchases/:id` — cabeçalho com fornecedor/usuário resolvidos, ou null. */
  async findDetail(id: Id): Promise<PurchaseDetailRecord | null> {
    const [row] = await this.tx
      .select({
        id: purchases.id,
        invoiceNumber: purchases.invoiceNumber,
        issuedOn: purchases.issuedOn,
        note: purchases.note,
        total: purchases.total,
        supplierId: purchases.supplierId,
        supplierName: suppliers.name,
        createdByName: users.name,
        createdAt: purchases.createdAt,
      })
      .from(purchases)
      .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
      .leftJoin(users, eq(users.id, purchases.createdBy))
      .where(eq(purchases.id, id));
    return row ?? null;
  }

  /** Linhas do documento com nome do produto; `products.name ASC, purchase_item.seq ASC`. */
  async listItems(id: Id): Promise<PurchaseItemViewRecord[]> {
    return this.tx
      .select({
        id: purchaseItems.id,
        productId: purchaseItems.productId,
        productName: products.name,
        quantity: purchaseItems.quantity,
        unitCost: purchaseItems.unitCost,
        lineTotal: purchaseItems.lineTotal,
        batchNo: purchaseItems.batchNo,
        expiryDate: purchaseItems.expiryDate,
      })
      .from(purchaseItems)
      .leftJoin(products, eq(products.id, purchaseItems.productId))
      .where(eq(purchaseItems.purchaseId, id))
      // Nome do produto e, no empate (mesmo produto em duas linhas), a ordem de
      // inserção — é como o gerente digitou o documento.
      .orderBy(products.name, purchaseItems.seq);
  }
}

