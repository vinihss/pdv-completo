import { and, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../client.js";
import { products, stockMovements, users } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import { SYSTEM_USER_ID } from "../../../domain/constants.js";
import { normalizeAccents } from "../../../domain/text.js";
import { replayMovingAverage, type MovingAverage } from "../../../application/stock/stock.usecases.js";
import { notImplemented } from "./shared.js";
import type {
  Id,
  MovingAverageRecord,
  StockMovementViewRecord,
  StockRepository,
  TrackedStockProductRecord,
} from "../../../application/ports/repositories.js";

// =====================================================================
// Estoque (ledger)
// =====================================================================

export class PostgresStockRepository implements StockRepository {
  constructor(private readonly tx: Tx) {}

  /** Saldo = soma de `quantity_delta` (idêntico a `stockBalance`). */
  async balance(productId: Id): Promise<number> {
    const rows = await this.tx
      .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
      .from(stockMovements)
      .where(eq(stockMovements.productId, productId));
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Espelha `applyStockMovementTx`: valida delta ≠ 0, insere no ledger e devolve
   * o saldo pós-movimento. O evento `stock.movement` (room `inventory`) NÃO é
   * emitido aqui — o use case migrado chama `session.outbox.enqueue` na mesma
   * transação (o adapter não tem acesso ao session).
   *
   * ADIÇÃO (Onda 2): `orderId`/`purchaseItemId` — colunas reais que os refunds
   * por comanda/item gravam; sem elas o estorno ficaria órfão no ledger.
   */
  async recordMovement(input: {
    productId: Id;
    quantityDelta: number;
    type: "sale" | "refund" | "purchase" | "adjustment";
    unitCost?: number;
    purchaseItemId?: Id | null;
    orderId?: Id | null;
    orderItemId?: Id | null;
    note?: string | null;
    actorId?: Id;
  }): Promise<number> {
    if (input.quantityDelta === 0) {
      throw Errors.validationFailed({ field: "quantity", reason: "não pode ser zero" });
    }
    await this.tx.insert(stockMovements).values({
      productId: input.productId,
      type: input.type,
      quantityDelta: input.quantityDelta,
      unitCost: input.unitCost ?? null,
      purchaseItemId: input.purchaseItemId ?? null,
      orderId: input.orderId ?? null,
      orderItemId: input.orderItemId ?? null,
      note: input.note ?? null,
      createdBy: input.actorId ?? SYSTEM_USER_ID,
    });
    return this.balance(input.productId);
  }

  // TODO: o ledger de hoje não tem "reserva" — a baixa acontece como
  // movimento `sale` por item em `addItemsUsecase` (e o estorno é `refund`).
  // Se reserve/release forem reais, definir semântica (hold? linha auxiliar?)
  // na onda que migrar order.usecases; inventar aqui seria mentir o port.
  async reserveForOrder(_orderId: Id): Promise<void> {
    return notImplemented("StockRepository.reserveForOrder — conceito não existe no ledger atual");
  }

  async releaseForOrder(_orderId: Id): Promise<void> {
    return notImplemented("StockRepository.releaseForOrder — conceito não existe no ledger atual");
  }

  // ---------- ADIÇÃO (Onda 2 — hub de pedidos) ----------

  /** Saldos de vários produtos em uma query agrupada (mesmo SQL de `stockBalances`). */
  async balances(productIds: Id[]): Promise<Map<Id, number>> {
    if (productIds.length === 0) return new Map();
    const rows = await this.tx
      .select({ productId: stockMovements.productId, total: sql<number>`sum(${stockMovements.quantityDelta})` })
      .from(stockMovements)
      .where(inArray(stockMovements.productId, productIds))
      .groupBy(stockMovements.productId);
    return new Map(rows.map((r) => [r.productId, r.total ?? 0]));
  }

  /** Replay do ledger de 1 produto — mesma query/ordenação de `computeMovingAverageTx`. */
  async movingAverage(productId: Id, fallbackCost: number): Promise<MovingAverageRecord> {
    const rows = await this.tx
      .select({ quantityDelta: stockMovements.quantityDelta, unitCost: stockMovements.unitCost })
      .from(stockMovements)
      .where(eq(stockMovements.productId, productId))
      .orderBy(stockMovements.createdAt, stockMovements.seq);
    return replayMovingAverage(rows, fallbackCost);
  }

  /** Custo médio de vários produtos — replay em 1 query, como `averageCosts`. */
  async averageCosts(productIds: Id[]): Promise<Map<Id, MovingAverageRecord>> {
    const res = new Map<Id, MovingAverage>();
    if (productIds.length === 0) return res;
    const rows = await this.tx
      .select({
        productId: stockMovements.productId,
        quantityDelta: stockMovements.quantityDelta,
        unitCost: stockMovements.unitCost,
      })
      .from(stockMovements)
      .where(inArray(stockMovements.productId, productIds))
      .orderBy(stockMovements.createdAt, stockMovements.seq);
    const groups = new Map<Id, { quantityDelta: number; unitCost: number | null }[]>();
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

  /**
   * Linhas de `GET /stock` — mesmos filtros de `listStockUsecase` (trackStock,
   * busca `unaccent ILIKE`, `name ASC`) + contagem + nome de categoria
   * resolvido (o use case monta saldo/média a partir disto).
   */
  async listTrackedProducts(query: { search?: string; limit: number; offset: number }): Promise<{
    rows: TrackedStockProductRecord[];
    total: number;
  }> {
    const conditions: SQL[] = [eq(products.trackStock, true)];
    if (query.search) {
      const term = `%${normalizeAccents(query.search)}%`;
      conditions.push(sql`unaccent(${products.name}) ILIKE unaccent(${term})`);
    }
    const where = and(...conditions);

    const rows = await this.tx.query.products.findMany({
      where,
      limit: query.limit,
      offset: query.offset,
      orderBy: (p, { asc: asc_ }) => asc_(p.name),
    });
    const totalRow = await this.tx.select({ count: count() }).from(products).where(where);
    const categoryNames = await this.tx.query.categories.findMany({ columns: { id: true, name: true } });
    const catMap = new Map(categoryNames.map((c) => [c.id, c.name]));

    return {
      rows: rows.map((p) => ({
        productId: p.id,
        name: p.name,
        categoryId: p.categoryId,
        categoryName: p.categoryId ? catMap.get(p.categoryId) ?? null : null,
        unit: p.unit,
        costPrice: p.costPrice,
        lowStockThreshold: p.lowStockThreshold,
      })),
      total: Number(totalRow[0]?.count ?? rows.length),
    };
  }

  /**
   * ADIÇÃO (Onda financeiro — valorização): mesma forma de `listTrackedProducts`,
   * mas com a busca ORIGINAL do `inventoryValuationUsecase`
   * (`lower(name) LIKE lower(%term%)`, sem `unaccent`) — preserva a régua exata
   * de `GET /inventory/value`.
   */
  async listValuationProducts(query: { search?: string; limit: number; offset: number }): Promise<{
    rows: TrackedStockProductRecord[];
    total: number;
  }> {
    const conditions: SQL[] = [eq(products.trackStock, true)];
    if (query.search) {
      conditions.push(sql`lower(${products.name}) like lower(${`%${query.search}%`})`);
    }
    const where = and(...conditions);

    const rows = await this.tx.query.products.findMany({
      where,
      limit: query.limit,
      offset: query.offset,
      orderBy: (p, { asc: asc_ }) => asc_(p.name),
    });
    const totalRow = await this.tx.select({ count: count() }).from(products).where(where);
    const categoryNames = await this.tx.query.categories.findMany({ columns: { id: true, name: true } });
    const catMap = new Map(categoryNames.map((c) => [c.id, c.name]));

    return {
      rows: rows.map((p) => ({
        productId: p.id,
        name: p.name,
        categoryId: p.categoryId,
        categoryName: p.categoryId ? catMap.get(p.categoryId) ?? null : null,
        unit: p.unit,
        costPrice: p.costPrice,
        lowStockThreshold: p.lowStockThreshold,
      })),
      total: Number(totalRow[0]?.count ?? rows.length),
    };
  }

  /** Linhas de `GET /stock/movements` (produto/usuário resolvidos, `createdAt DESC`). */
  async listMovements(query: { productId?: Id; limit: number; offset: number }): Promise<{
    rows: StockMovementViewRecord[];
    total: number;
  }> {
    const where = query.productId ? eq(stockMovements.productId, query.productId) : undefined;
    const rows = await this.tx
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
      .where(where)
      .orderBy(desc(stockMovements.createdAt))
      .limit(query.limit)
      .offset(query.offset);
    const totalRow = await this.tx.select({ count: count() }).from(stockMovements).where(where);
    return {
      rows: rows.map((r) => ({
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
      total: Number(totalRow[0]?.count ?? rows.length),
    };
  }

  /** Movimentos `sale` de um item — estorno em `deleteItem` lê o ledger, não flags. */
  async listSalesMovementsForItem(orderItemId: Id): Promise<Array<{ quantityDelta: number }>> {
    return this.tx
      .select({ quantityDelta: stockMovements.quantityDelta })
      .from(stockMovements)
      .where(and(eq(stockMovements.orderItemId, orderItemId), eq(stockMovements.type, "sale")));
  }

  /** Movimentos `sale` de uma comanda — estorno integral em `cancelOrder`. */
  async listSalesMovementsForOrder(orderId: Id): Promise<
    Array<{ productId: Id; orderItemId: Id | null; quantityDelta: number }>
  > {
    return this.tx
      .select({
        productId: stockMovements.productId,
        orderItemId: stockMovements.orderItemId,
        quantityDelta: stockMovements.quantityDelta,
      })
      .from(stockMovements)
      .where(and(eq(stockMovements.orderId, orderId), eq(stockMovements.type, "sale")));
  }
}

