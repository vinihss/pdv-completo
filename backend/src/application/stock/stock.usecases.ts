// Ledger de estoque (migration 0016): o saldo de um produto é a soma dos
// deltas em `stock_movement` — nunca uma coluna cacheada (sem drift entre
// contador e histórico). Um único helper (`applyStockMovementTx`) grava o
// movimento E os eventos de realtime na mesma transação da escrita de
// domínio (regra do repo: audit log + outbox no mesmo commit).
//
// Tipos de movimento:
//   - sale        lançamento de item na comanda (-qty)
//   - refund      estorno: item removido / comanda cancelada (+qty)
//   - purchase    entrada de mercadoria manual (+qty)
//   - adjustment  ajuste/contagem manual (Δ sinalizado)
//
// Desenhado para evoluir a ficha técnica depois: deltas genéricos por
// produto; futuro próximo só adiciona ingredient/product_ingredient e
// passa a *calcular* esses deltas a partir da receita.

import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { stockMovements, products, categories, users } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";

export const INVENTORY_ROOM = "inventory";

export type StockMovementType = "sale" | "refund" | "purchase" | "adjustment";

// Saldo atual a partir do ledger — versão síncrona (dentro de db.transaction,
// o driver better-sqlite3 exige métodos terminais; ver order.usecases).
export function stockBalance(tx: any, productId: string): number {
  const row = tx
    .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
    .from(stockMovements)
    .where(eq(stockMovements.productId, productId))
    .all()[0] as { total: number } | undefined;
  return row?.total ?? 0;
}

// Saldo de um produto — versão assíncrona, fora de transação.
export async function currentStock(productId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
    .from(stockMovements)
    .where(eq(stockMovements.productId, productId));
  return rows[0]?.total ?? 0;
}

// Saldos de vários produtos em uma única query (usado na listagem).
export async function stockBalances(productIds: string[]): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({ productId: stockMovements.productId, total: sql<number>`sum(${stockMovements.quantityDelta})` })
    .from(stockMovements)
    .where(inArray(stockMovements.productId, productIds))
    .groupBy(stockMovements.productId);
  return new Map(rows.map((r) => [r.productId, r.total ?? 0]));
}

// Grava um movimento no ledger + evento `stock.movement` no room "inventory"
// na mesma transação. Retorna { row, balance } (saldo pós-movimento).
export function applyStockMovementTx(
  tx: any,
  input: {
    productId: string;
    type: StockMovementType;
    quantityDelta: number;
    orderId?: string | null;
    orderItemId?: string | null;
    note?: string | null;
    createdBy: string;
  }
) {
  if (input.quantityDelta === 0) throw Errors.validationFailed({ field: "quantity", reason: "não pode ser zero" });
  const row = tx
    .insert(stockMovements)
    .values({
      productId: input.productId,
      type: input.type,
      quantityDelta: input.quantityDelta,
      orderId: input.orderId ?? null,
      orderItemId: input.orderItemId ?? null,
      note: input.note ?? null,
      createdBy: input.createdBy,
    })
    .returning()
    .get();

  const balance = stockBalance(tx, input.productId);
  enqueueEvent(tx, INVENTORY_ROOM, "stock.movement", {
    productId: input.productId,
    type: input.type,
    quantityDelta: input.quantityDelta,
    quantity: balance,
    orderId: input.orderId ?? null,
  });

  return { row, balance };
}

// ---------- GET /stock ----------
export async function listStockUsecase(input: { lowOnly?: boolean; search?: string; limit: number; offset: number }) {
  const conditions = [eq(products.trackStock, true)];
  if (input.search) conditions.push(like(products.name, `%${input.search}%`));
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

  const data = rows.map((p) => ({
    productId: p.id,
    name: p.name,
    categoryId: p.categoryId,
    categoryName: p.categoryId ? catMap.get(p.categoryId) ?? null : null,
    unitCost: p.costPrice,
    quantity: balances.get(p.id) ?? 0,
    lowStockThreshold: p.lowStockThreshold,
    low: (balances.get(p.id) ?? 0) <= p.lowStockThreshold,
  }));

  return {
    data: input.lowOnly ? data.filter((d) => d.low) : data,
    total: totalRow[0]?.count ?? rows.length,
  };
}

// ---------- GET /stock/movements ----------
export async function getStockMovementsUsecase(input: { productId?: string; limit: number; offset: number }) {
  const where = input.productId ? eq(stockMovements.productId, input.productId) : undefined;
  const rows = await db
    .select({
      id: stockMovements.id,
      productId: stockMovements.productId,
      productName: products.name,
      type: stockMovements.type,
      quantityDelta: stockMovements.quantityDelta,
      orderId: stockMovements.orderId,
      note: stockMovements.note,
      userName: users.name,
      createdAt: stockMovements.createdAt,
    })
    .from(stockMovements)
    .leftJoin(products, eq(products.id, stockMovements.productId))
    .leftJoin(users, eq(users.id, stockMovements.createdBy))
    .where(where as any)
    .orderBy(desc(stockMovements.createdAt))
    .limit(input.limit)
    .offset(input.offset);

  const totalRow = await db.select({ count: sql<number>`count(*)` }).from(stockMovements).where(where as any);

  return {
    data: rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      productName: r.productName,
      type: r.type,
      quantityDelta: r.quantityDelta,
      orderId: r.orderId,
      note: r.note,
      userName: r.userName,
      createdAt: r.createdAt,
    })),
    total: totalRow[0]?.count ?? rows.length,
  };
}

// ---------- POST /stock/:productId/movements (manual, manager) ----------
export async function registerStockMovementUsecase(input: {
  productId: string;
  type: "purchase" | "adjustment";
  quantity: number; // purchase: positivo (+qty); adjustment: sinalizado (±)
  note?: string;
  userId: string;
}) {
  if (input.type === "purchase" && input.quantity <= 0) {
    throw Errors.validationFailed({ field: "quantity", reason: "entrada deve ser maior que zero" });
  }
  if (input.type === "adjustment" && input.quantity === 0) {
    throw Errors.validationFailed({ field: "quantity", reason: "ajuste não pode ser zero" });
  }

  const product = await db.query.products.findFirst({ where: eq(products.id, input.productId) });
  if (!product) throw Errors.notFound("Produto");
  if (!product.trackStock) {
    throw Errors.validationFailed({ field: "productId", reason: "produto não controla estoque (habilite no cadastro)" });
  }

  db.transaction((tx) => {
    const { row } = applyStockMovementTx(tx, {
      productId: input.productId,
      type: input.type,
      quantityDelta: input.quantity,
      note: input.note ?? null,
      createdBy: input.userId,
    });
    logAction(tx, input.userId, "stock_movement_manual", null, {
      productId: input.productId,
      type: row.type,
      quantityDelta: row.quantityDelta,
      note: row.note,
    });
  });

  return { productId: input.productId, type: input.type, quantityDelta: input.quantity };
}