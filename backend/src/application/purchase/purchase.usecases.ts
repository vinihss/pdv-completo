// Compras e fornecedores (migration 0017) — entrada de mercadoria COMO
// DOCUMENTO multi-item. Cada linha vira um movimento `purchase` no ledger com
// unit_cost — evento de valoração do custo médio móvel (replay em
// stock.usecases). Regra do repo: documento + movimentos + sync de média +
// audit + outbox na MESMA transação.
//
// `product.cost_price` é espelhado para a média corrente (display) após cada
// valoração — mesma disciplina do payment_method denormalizado: o ledger é a
// fonte da verdade; a coluna é só leitura conveniente.
//
// batch_no/expiry_date são informativos (rastreio; a baixa é por produto, sem
// FIFO — ver docs/08-estoque-profissional.md).

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { suppliers, purchases, purchaseItems, products, users } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";
import {
  applyStockMovementTx,
  averageCosts,
  computeMovingAverageTx,
  round2,
  stockBalances,
  INVENTORY_ROOM,
} from "../stock/stock.usecases.js";

// ---------- Fornecedores ----------

function serializeSupplier(s: typeof suppliers.$inferSelect) {
  return {
    id: s.id,
    name: s.name,
    phone: s.phone,
    taxId: s.taxId,
    active: s.active,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export async function listSuppliersUsecase(input: { activeOnly?: boolean; limit: number; offset: number }) {
  const where = input.activeOnly ? eq(suppliers.active, true) : undefined;
  const rows = await db.query.suppliers.findMany({
    where,
    orderBy: (s, { asc }) => asc(s.name),
    limit: input.limit,
    offset: input.offset,
  });
  const totalRow = await db.select({ count: sql<number>`count(*)` }).from(suppliers).where(where as any);
  return { data: rows.map(serializeSupplier), total: totalRow[0]?.count ?? rows.length };
}

export async function createSupplierUsecase(input: { name: string; phone?: string | null; taxId?: string | null }, actorId: string) {
  if (!input.name.trim()) throw Errors.validationFailed({ field: "name" });
  const created = db.transaction((tx) => {
    const row = tx
      .insert(suppliers)
      .values({ name: input.name.trim(), phone: input.phone?.trim() || null, taxId: input.taxId?.trim() || null })
      .returning()
      .get();
    logAction(tx, actorId, "supplier_created", null, { supplierId: row.id, name: row.name });
    return row;
  });
  return serializeSupplier(created);
}

export async function updateSupplierUsecase(
  id: string,
  input: { name?: string; phone?: string | null; taxId?: string | null; active?: boolean },
  actorId: string
) {
  const existing = await db.query.suppliers.findFirst({ where: eq(suppliers.id, id) });
  if (!existing) throw Errors.notFound("Fornecedor");
  if (input.name !== undefined && !input.name.trim()) throw Errors.validationFailed({ field: "name" });

  const updated = db.transaction((tx) => {
    const row = tx
      .update(suppliers)
      .set({
        name: input.name?.trim() ?? existing.name,
        phone: input.phone !== undefined ? input.phone?.trim() || null : existing.phone,
        taxId: input.taxId !== undefined ? input.taxId?.trim() || null : existing.taxId,
        active: input.active ?? existing.active,
        updatedAt: sql`(current_timestamp)`,
      })
      .where(eq(suppliers.id, id))
      .returning()
      .get();
    logAction(tx, actorId, "supplier_updated", null, { supplierId: row.id });
    return row;
  });
  return serializeSupplier(updated);
}

// ---------- Compras (documento) ----------

export type PurchaseLineInput = {
  productId: string;
  quantity: number;
  unitCost: number;
  batchNo?: string | null;
  expiryDate?: string | null;
};

export async function createPurchaseUsecase(
  input: {
    supplierId?: string | null;
    invoiceNumber?: string | null;
    issuedOn?: string | null;
    note?: string | null;
    items: PurchaseLineInput[];
  },
  actorId: string
) {
  if (!input.items.length) throw Errors.validationFailed({ field: "items", reason: "compra sem itens" });

  const result = db.transaction((tx) => {
    // Valida produtos (existem, ativos e rastreiam estoque) AOf o documento,
    // para nunca gravar compra sem efeito no ledger.
    for (const line of input.items) {
      if (!Number.isFinite(line.quantity) || line.quantity <= 0)
        throw Errors.validationFailed({ field: "quantity", reason: "quantidade deve ser maior que zero" });
      if (!Number.isFinite(line.unitCost) || line.unitCost < 0)
        throw Errors.validationFailed({ field: "unitCost", reason: "custo deve ser maior ou igual a zero" });
      const product = tx.query.products.findFirst({ where: eq(products.id, line.productId) }).sync();
      if (!product || !product.active) throw Errors.notFound("Produto");
      if (!product.trackStock) {
        throw Errors.validationFailed({
          field: "productId",
          reason: `${product.name} não controla estoque (habilite o rastreamento no cadastro)`,
        });
      }
    }

    const total = round2(input.items.reduce((sum, l) => sum + l.quantity * l.unitCost, 0));
    const purchase = tx
      .insert(purchases)
      .values({
        supplierId: input.supplierId ?? null,
        invoiceNumber: input.invoiceNumber?.trim() || null,
        issuedOn: input.issuedOn ?? null,
        note: input.note?.trim() || null,
        total,
        createdBy: actorId,
      })
      .returning()
      .get();

    const note = purchase.invoiceNumber ? `Entrada nota ${purchase.invoiceNumber}` : "Entrada de compra";
    const lines: (PurchaseLineInput & { id: string; lineTotal: number })[] = [];
    for (const line of input.items) {
      const item = tx
        .insert(purchaseItems)
        .values({
          purchaseId: purchase.id,
          productId: line.productId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          lineTotal: round2(line.quantity * line.unitCost),
          batchNo: line.batchNo?.trim() || null,
          expiryDate: line.expiryDate || null,
          createdBy: actorId,
        })
        .returning()
        .get();

      // Movimento no ledger na mesma transação do documento (rollback
      // conjunto). unit_cost = evento de valoração da média móvel.
      applyStockMovementTx(tx, {
        productId: line.productId,
        type: "purchase",
        quantityDelta: line.quantity,
        unitCost: line.unitCost,
        purchaseItemId: item.id,
        note,
        createdBy: actorId,
      });
      lines.push({ ...line, id: item.id, lineTotal: item.lineTotal });
    }

    // Espelha o custo médio corrente em product.cost_price (display).
    for (const line of lines) {
      const avg = computeMovingAverageTx(tx, line.productId);
      tx.update(products).set({ costPrice: avg.avg }).where(eq(products.id, line.productId)).run();
      if (avg.avg > 0) {
        enqueueEvent(tx, INVENTORY_ROOM, "purchase.received", {
          purchaseId: purchase.id,
          productId: line.productId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          averageCost: avg.avg,
        });
      }
    }

    logAction(tx, actorId, "purchase_received", null, {
      purchaseId: purchase.id,
      supplierId: input.supplierId ?? null,
      invoiceNumber: purchase.invoiceNumber,
      items: lines.length,
      total,
    });

    return { purchase, lines };
  });

  return getPurchaseUsecase(result.purchase.id);
}

export async function listPurchasesUsecase(input: { limit: number; offset: number }) {
  const rows = await db
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
      itemCount: sql<number>`count(${purchaseItems.id})`,
    })
    .from(purchases)
    .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .leftJoin(users, eq(users.id, purchases.createdBy))
    .leftJoin(purchaseItems, eq(purchaseItems.purchaseId, purchases.id))
    .groupBy(purchases.id)
    .orderBy(desc(purchases.createdAt))
    .limit(input.limit)
    .offset(input.offset);

  const totalRow = await db.select({ count: sql<number>`count(*)` }).from(purchases);
  return { data: rows, total: totalRow[0]?.count ?? rows.length };
}

export async function getPurchaseUsecase(id: string) {
  const purchase = await db
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
    .where(eq(purchases.id, id))
    .get();
  if (!purchase) throw Errors.notFound("Compra");

  const items = await db
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
    .orderBy(products.name);

  // Média móvel por produto envolvido (para a UI mostrar o custo atual)
  const productIds = [...new Set(items.map((i) => i.productId))];
  const averages = await averageCosts(productIds);
  const averagesMap: Record<string, number> = {};
  for (const [pid, v] of averages) averagesMap[pid] = v.avg;

  return { ...purchase, items, averages: averagesMap };
}

// ---------- Valorização do estoque ----------
// Σ saldo × custo médio por produto; resumo por categoria + total geral.
export async function inventoryValuationUsecase(input: { search?: string; lowOnly?: boolean; limit: number; offset: number }) {
  const conditions = [eq(products.trackStock, true)];
  if (input.search) conditions.push(sql`lower(${products.name}) like lower(${'%' + input.search + '%'})`);
  const where = and(...conditions);

  const rows = await db.query.products.findMany({
    where,
    limit: input.limit,
    offset: input.offset,
    orderBy: (p, { asc }) => asc(p.name),
  });
  const totalRow = await db.select({ count: sql<number>`count(*)` }).from(products).where(where as any);

  const categoryNames = await db.query.categories.findMany({ columns: { id: true, name: true } });
  const catMap = new Map(categoryNames.map((c) => [c.id, c.name]));
  const balances = await stockBalances(rows.map((p) => p.id));
  const averages = await averageCosts(rows.map((p) => p.id));

  const data = rows.map((p) => {
    const quantity = round2(balances.get(p.id) ?? 0);
    const averageCost = round2(averages.get(p.id)?.avg ?? p.costPrice);
    return {
      productId: p.id,
      name: p.name,
      categoryId: p.categoryId,
      categoryName: p.categoryId ? catMap.get(p.categoryId) ?? null : null,
      unit: p.unit,
      quantity,
      averageCost,
      value: round2(quantity * averageCost),
    };
  });

  const filtered = input.lowOnly ? data.filter((d) => d.quantity <= 1e-9) : data;
  const byCategory = new Map<string, { categoryName: string; quantity: number; value: number }>();
  for (const d of filtered) {
    const key = d.categoryName ?? "Sem categoria";
    const cur = byCategory.get(key) ?? { categoryName: key, quantity: 0, value: 0 };
    cur.quantity += d.quantity;
    cur.value = round2(cur.value + d.value);
    byCategory.set(key, cur);
  }
  const totalValue = round2(filtered.reduce((sum, d) => sum + d.value, 0));

  return {
    data: filtered,
    categories: [...byCategory.values()],
    totalValue,
    total: totalRow[0]?.count ?? rows.length,
  };
}

// Fonte da verdade do custo médio vigente de um produto (leitura avulsa).
export async function averageCostOf(productId: string): Promise<number> {
  const product = await db.query.products.findFirst({ where: eq(products.id, productId) });
  if (!product) throw Errors.notFound("Produto");
  const avg = await averageCosts([productId]);
  return avg.get(productId)?.avg ?? product.costPrice;
}