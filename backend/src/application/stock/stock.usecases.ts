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

import { and, count, desc, eq, inArray, like, sql } from "drizzle-orm";
import { db, type Tx } from "../../infra/db/client.js";
import { stockMovements, products, categories, users } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";

export const INVENTORY_ROOM = "inventory";

export type StockMovementType = "sale" | "refund" | "purchase" | "adjustment";

// ---------- Custo médio móvel (0017) ----------
// A média é um REPLAY do ledger sobre os eventos de valoração (quantity_delta >
// 0 com unit_cost): avg_n = (avg_prev*qty_prev + unit_cost*delta) / (qty_prev +
// delta). Vendas/refunds e ajuste negativo mudam quantidade, não a média;
// ajuste positivo sem custo só soma quantidade. Nunca coluna de estado.

export type MovingAverage = { avg: number; qty: number };

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function replayMovingAverage(rows: { quantityDelta: number; unitCost: number | null }[], fallbackCost: number): MovingAverage {
  let qty = 0;
  let avg = 0;
  let costed = false;
  for (const r of rows) {
    const d = r.quantityDelta;
    if (d > 0) {
      if (r.unitCost != null) {
        avg = qty > 0 ? (avg * qty + r.unitCost * d) / (qty + d) : r.unitCost;
        costed = true;
      }
      qty += d;
    } else {
      qty += d;
    }
  }
  if (qty < 0) qty = 0; // saldo negativo (over-consume) não valoriza: medida física
  return costed ? { avg: round2(avg), qty: round2(qty) } : { avg: round2(fallbackCost), qty: round2(qty) };
}

// Média móvel vigente — versão transacional (o Node Postgres é assíncrono).
// fallbackCost = cost_price manual do cadastro (usado antes da 1ª valoração).
// Ordena por `seq` (a sequência bigserial substitui o `rowid` do SQLite) para
// desempatar movimentos gravados no mesmo milissegundo — sem isso o replay
// poderia aplicar uma compra DEPOIS da venda que a expressou.
export async function computeMovingAverageTx(tx: Tx, productId: string, fallbackCost = 0): Promise<MovingAverage> {
  const rows = await tx
    .select({ quantityDelta: stockMovements.quantityDelta, unitCost: stockMovements.unitCost })
    .from(stockMovements)
    .where(eq(stockMovements.productId, productId))
    .orderBy(stockMovements.createdAt, stockMovements.seq);
  return replayMovingAverage(rows, fallbackCost);
}

// Média móvel de vários produtos em uma query agrupada (listagem/valorização).
export async function averageCosts(productIds: string[]): Promise<Map<string, MovingAverage>> {
  const res = new Map<string, MovingAverage>();
  if (productIds.length === 0) return res;
  const rows = await db
    .select({
      productId: stockMovements.productId,
      quantityDelta: stockMovements.quantityDelta,
      unitCost: stockMovements.unitCost,
      createdAt: stockMovements.createdAt,
    })
    .from(stockMovements)
    .where(inArray(stockMovements.productId, productIds))
    .orderBy(stockMovements.createdAt, stockMovements.seq);
  const groups = new Map<string, { quantityDelta: number; unitCost: number | null }[]>();
  for (const r of rows) {
    let list = groups.get(r.productId);
    if (!list) {
      list = [];
      groups.set(r.productId, list);
    }
    list.push({ quantityDelta: r.quantityDelta, unitCost: r.unitCost });
  }
  for (const [productId, group] of groups) res.set(productId, replayMovingAverage(group, 0));
  return res;
}

// Saldo atual a partir do ledger — versão transacional (usada dentro de
// db.transaction, que no Node Postgres exige tudo awaited).
export async function stockBalance(tx: Tx, productId: string): Promise<number> {
  const rows = await tx
    .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
    .from(stockMovements)
    .where(eq(stockMovements.productId, productId));
  return Number(rows[0]?.total ?? 0);
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
export async function applyStockMovementTx(
  tx: Tx,
  input: {
    productId: string;
    type: StockMovementType;
    quantityDelta: number;
    unitCost?: number | null;
    purchaseItemId?: string | null;
    orderId?: string | null;
    orderItemId?: string | null;
    note?: string | null;
    createdBy: string;
  },
): Promise<{ row: typeof stockMovements.$inferSelect; balance: number }> {
  if (input.quantityDelta === 0) throw Errors.validationFailed({ field: "quantity", reason: "não pode ser zero" });
  const [row] = await tx
    .insert(stockMovements)
    .values({
      productId: input.productId,
      type: input.type,
      quantityDelta: input.quantityDelta,
      unitCost: input.unitCost ?? null,
      purchaseItemId: input.purchaseItemId ?? null,
      orderId: input.orderId ?? null,
      orderItemId: input.orderItemId ?? null,
      note: input.note ?? null,
      createdBy: input.createdBy,
    })
    .returning();

  const balance = await stockBalance(tx, input.productId);
  await enqueueEvent(tx, INVENTORY_ROOM, "stock.movement", {
    productId: input.productId,
    type: input.type,
    quantityDelta: input.quantityDelta,
    quantity: balance,
    unitCost: input.unitCost ?? null,
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
  const totalRow = await db.select({ count: count() }).from(products).where(where as any);

  const categoryNames = await db.query.categories.findMany({ columns: { id: true, name: true } });
  const catMap = new Map(categoryNames.map((c) => [c.id, c.name]));
  const balances = await stockBalances(rows.map((p) => p.id));
  const averages = await averageCosts(rows.map((p) => p.id));

  const data = rows.map((p) => {
    const balance = balances.get(p.id) ?? 0;
    const avg = averages.get(p.id);
    return {
      productId: p.id,
      name: p.name,
      categoryId: p.categoryId,
      categoryName: p.categoryId ? catMap.get(p.categoryId) ?? null : null,
      unit: p.unit,
      unitCost: avg?.avg ?? p.costPrice, // custo médio móvel vigente (fallback: manual)
      manualCost: p.costPrice,
      quantity: balance,
      lowStockThreshold: p.lowStockThreshold,
      low: balance <= p.lowStockThreshold,
    };
  });

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
      unitCost: stockMovements.unitCost,
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

  const totalRow = await db.select({ count: count() }).from(stockMovements).where(where as any);

  return {
    data: rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      productName: r.productName,
      type: r.type,
      quantityDelta: r.quantityDelta,
      unitCost: r.unitCost,
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

  await db.transaction(async (tx) => {
    const { row } = await applyStockMovementTx(tx, {
      productId: input.productId,
      type: input.type,
      quantityDelta: input.quantity,
      note: input.note ?? null,
      createdBy: input.userId,
    });
    await logAction(tx, input.userId, "stock_movement_manual", null, {
      productId: input.productId,
      type: row.type,
      quantityDelta: row.quantityDelta,
      note: row.note,
    });
  });

  return { productId: input.productId, type: input.type, quantityDelta: input.quantity };
}