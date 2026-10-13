import { and, asc, count, desc, eq, gte, inArray, lte, notInArray, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../client.js";
import { orderItems, orderPayments, orders, products, restaurantTables } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import { round2 } from "../../../domain/money.js";
import { notImplemented } from "./shared.js";
import type {
  CustomerOpenOrderRecord,
  CustomerOrderHistoryRecord,
  Id,
  OrderChannel,
  OrderItemRow,
  OrderItemWithProduct,
  OrderPaymentLineRow,
  OrderRecord,
  OrderRepository,
  OrderRow,
  Page,
  PageQuery,
} from "../../../application/ports/repositories.js";

// =====================================================================
// Comandas
// =====================================================================

/**
 * Total da comanda = soma de `unit_price × quantity` do SNAPSHOT, excluindo
 * itens `cancelled`, + taxa de entrega (mesmíssimo cálculo de
 * `computeOrderTotal`). `deliveryFee` entra aqui porque não é item.
 */
async function orderTotals(
  tx: Tx,
  rows: Array<{ id: Id; deliveryFee: number | null }>,
): Promise<Map<Id, number>> {
  const totals = new Map<Id, number>();
  if (rows.length === 0) return totals;
  const agg = await tx
    .select({
      orderId: orderItems.orderId,
      total: sql<number>`coalesce(sum(${orderItems.unitPrice} * ${orderItems.quantity}), 0)`,
    })
    .from(orderItems)
    .where(
      and(
        inArray(
          orderItems.orderId,
          rows.map((r) => r.id),
        ),
        sql`${orderItems.status} <> 'cancelled'`,
      ),
    )
    .groupBy(orderItems.orderId);
  const byOrder = new Map(agg.map((r) => [r.orderId, Number(r.total ?? 0)]));
  for (const row of rows) {
    totals.set(row.id, round2((byOrder.get(row.id) ?? 0) + (row.deliveryFee ?? 0)));
  }
  return totals;
}

// ---------- ADIÇÃO (Onda 2): mappers linha-a-linha (fiéis ao schema) ----------

function toOrderRow(r: typeof orders.$inferSelect): OrderRow {
  return {
    id: r.id,
    tableId: r.tableId,
    customerId: r.customerId,
    tabLabel: r.tabLabel,
    waiterId: r.waiterId,
    status: r.status,
    openedAt: r.openedAt,
    closedAt: r.closedAt,
    paymentMethod: r.paymentMethod,
    paymentConfirmedAt: r.paymentConfirmedAt,
    paymentConfirmedBy: r.paymentConfirmedBy,
    channel: r.channel as OrderChannel, // legado: linhas antigas podem trazer 'whatsapp'
    externalRef: r.externalRef,
    deliveryFee: r.deliveryFee,
    cancelReason: r.cancelReason,
    notes: r.notes,
  };
}

function toOrderItemRow(r: typeof orderItems.$inferSelect): OrderItemRow {
  return {
    id: r.id,
    orderId: r.orderId,
    productId: r.productId,
    quantity: r.quantity,
    unitPrice: r.unitPrice,
    costPrice: r.costPrice,
    selectedVariations: r.selectedVariations,
    notes: r.notes,
    status: r.status,
    version: r.version,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toPaymentLineRow(r: typeof orderPayments.$inferSelect): OrderPaymentLineRow {
  return {
    id: r.id,
    orderId: r.orderId,
    method: r.method,
    amount: r.amount,
    received: r.received,
    change: r.change,
    confirmed: r.confirmed,
    confirmedAt: r.confirmedAt,
    confirmedBy: r.confirmedBy,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

export class PostgresOrderRepository implements OrderRepository {
  constructor(private readonly tx: Tx) {}

  async findById(id: Id): Promise<OrderRecord | null> {
    const row = await this.tx.query.orders.findFirst({ where: eq(orders.id, id) });
    if (!row) return null;
    const totals = await orderTotals(this.tx, [{ id: row.id, deliveryFee: row.deliveryFee }]);
    return {
      id: row.id,
      status: row.status,
      tableId: row.tableId,
      total: totals.get(row.id) ?? 0,
    };
  }

  /** Comanda em aberto da mesa — mais recente primeiro (deve haver uma só). */
  async findOpenForTable(tableId: Id): Promise<OrderRecord | null> {
    const row = await this.tx.query.orders.findFirst({
      where: and(eq(orders.tableId, tableId), eq(orders.status, "open")),
      orderBy: desc(orders.openedAt),
    });
    if (!row) return null;
    const totals = await orderTotals(this.tx, [{ id: row.id, deliveryFee: row.deliveryFee }]);
    return { id: row.id, status: row.status, tableId: row.tableId, total: totals.get(row.id) ?? 0 };
  }

  /** Comandas abertas, mais recentes primeiro (mesma régua de `listOrdersUsecase` com status=open). */
  async listOpen(query: PageQuery): Promise<Page<OrderRecord>> {
    const where = eq(orders.status, "open");
    const rows = await this.tx.query.orders.findMany({
      where,
      orderBy: desc(orders.openedAt),
      limit: query.limit,
      offset: query.offset,
    });
    const totals = await orderTotals(
      this.tx,
      rows.map((r) => ({ id: r.id, deliveryFee: r.deliveryFee })),
    );
    const totalRow = await this.tx.select({ count: count() }).from(orders).where(where);
    return {
      data: rows.map((r) => ({
        id: r.id,
        status: r.status,
        tableId: r.tableId,
        total: totals.get(r.id) ?? 0,
      })),
      total: Number(totalRow[0]?.count ?? rows.length),
    };
  }

  // TODO(onda de order.usecases): `create` precisa do `waiterId` (coluna NOT
  // NULL) e da checagem de identificação (mesa/cliente/tabLabel) + claim
  // atômico da mesa + alerta/outbox — o input do port não carrega o ator.
  // Decidir na migração se o port ganha `waiterId`/`tabLabel` ou se o ator vem
  // do `TenantSession`; até lá, lançar erro é melhor que gravar errado.
  async create(_input: { tableId?: Id | null; customerId?: Id | null; channel: string }): Promise<OrderRecord> {
    return notImplemented("OrderRepository.create — precisa de waiterId/identificação (ver TODO no código)");
  }

  // TODO(onda de order.usecases): fechar/cancelar comanda tem invariantas de
  // pagamento, ledger (refund dos itens), caixa e eventos — replicar de
  // `closeOrderUsecase`/`cancelOrderUsecase` de uma vez. `expectedVersion` nem
  // tem coluna em `order` hoje (o lock otimista é de `order_item`).
  async transition(_id: Id, _status: OrderRecord["status"], _expectedVersion?: number): Promise<OrderRecord> {
    return notImplemented("OrderRepository.transition — invariantas de pagamento/ledger (ver TODO no código)");
  }

  // TODO(onda de order.usecases): não existe delete físico de comanda no
  // sistema atual (o cancelamento é a via de saída) — definir semântica antes.
  async delete(_id: Id): Promise<void> {
    return notImplemented("OrderRepository.delete — semântica a definir (o sistema cancela, não apaga)");
  }

  // ---------- ADIÇÃO (Onda 2 — hub de pedidos) ----------

  async findRow(id: Id): Promise<OrderRow | null> {
    const row = await this.tx.query.orders.findFirst({ where: eq(orders.id, id) });
    return row ? toOrderRow(row) : null;
  }

  /** Mesma régua de `listOrdersUsecase`: `openedAt DESC` + contagem em 1 query extra. */
  async listRows(query: { status?: "open" | "closed" | "cancelled"; limit: number; offset: number }): Promise<Page<OrderRow>> {
    const where = query.status ? eq(orders.status, query.status) : undefined;
    const rows = await this.tx.query.orders.findMany({
      where,
      orderBy: desc(orders.openedAt),
      limit: query.limit,
      offset: query.offset,
    });
    const totalRow = await this.tx.select({ count: count() }).from(orders).where(where);
    return { data: rows.map(toOrderRow), total: Number(totalRow[0]?.count ?? rows.length) };
  }

  /**
   * INSERT da comanda (`POST /orders`). Identificação (mesa/cliente/tabLabel)
   * é conferida pelo CHECK `chk_order_identification_required`; o claim da mesa
   * e o alerta ficam no use case.
   */
  async open(input: {
    waiterId: Id;
    tableId?: Id | null;
    customerId?: Id | null;
    tabLabel?: Id | null;
    channel?: OrderChannel;
    deliveryFee?: number | null;
    externalRef?: string | null;
    notes?: string | null;
  }): Promise<OrderRow> {
    const [row] = await this.tx
      .insert(orders)
      .values({
        waiterId: input.waiterId,
        tableId: input.tableId ?? null,
        customerId: input.customerId ?? null,
        tabLabel: input.tabLabel ?? null,
        channel: input.channel ?? "balcao",
        deliveryFee: input.deliveryFee ?? null,
        externalRef: input.externalRef ?? null,
        notes: input.notes ?? null,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "waiterId" });
    return toOrderRow(row);
  }

  async markClosed(id: Id): Promise<OrderRow> {
    const [row] = await this.tx
      .update(orders)
      .set({ status: "closed", closedAt: new Date().toISOString() })
      .where(eq(orders.id, id))
      .returning();
    if (!row) throw Errors.notFound("Comanda");
    return toOrderRow(row);
  }

  async markCancelled(id: Id, reason: string): Promise<OrderRow> {
    const [row] = await this.tx
      .update(orders)
      .set({ status: "cancelled", closedAt: new Date().toISOString(), cancelReason: reason })
      .where(eq(orders.id, id))
      .returning();
    if (!row) throw Errors.notFound("Comanda");
    return toOrderRow(row);
  }

  async listStatuses(ids: Id[]): Promise<Array<{ id: Id; status: string }>> {
    if (ids.length === 0) return [];
    const rows = await this.tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(inArray(orders.id, ids));
    return rows.map((r) => ({ id: r.id, status: r.status }));
  }

  /** ADIÇÃO (Onda 3 — self-service): comandas em lote (hidratação das listagens de entrega). */
  async listRowsByIds(ids: Id[]): Promise<OrderRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.tx.query.orders.findMany({ where: inArray(orders.id, ids) });
    return rows.map(toOrderRow);
  }

  /**
   * ADIÇÃO (Onda 3 — self-service): comanda em aberto mais recente do cliente
   * nos canais informados (retomada do self-service; `whatsapp` entra por
   * compatibilidade de leitura).
   */
  async findLatestOpenByCustomer(customerId: Id, channels: OrderChannel[]): Promise<OrderRow | null> {
    const row = await this.tx.query.orders.findFirst({
      where: and(eq(orders.customerId, customerId), inArray(orders.channel, channels), eq(orders.status, "open")),
      orderBy: desc(orders.openedAt),
    });
    return row ? toOrderRow(row) : null;
  }

  /** ADIÇÃO (Onda 3 — self-service): fecha os itens pendentes da entrega como entregues. */
  async markItemsDelivered(orderId: Id): Promise<void> {
    await this.tx
      .update(orderItems)
      .set({ status: "delivered" })
      .where(and(eq(orderItems.orderId, orderId), notInArray(orderItems.status, ["delivered", "cancelled"])));
  }

  // ---------- ADIÇÕES (Onda 3C — customer.usecases) ----------

  /**
   * Comandas abertas do cliente, mais antigas primeiro, com `tableNumber` por
   * LEFT JOIN — o bloco "comanda em aberto" do detalhe do cliente.
   */
  async listOpenByCustomer(customerId: Id): Promise<CustomerOpenOrderRecord[]> {
    const rows = await this.tx
      .select({
        id: orders.id,
        status: orders.status,
        openedAt: orders.openedAt,
        tabLabel: orders.tabLabel,
        deliveryFee: orders.deliveryFee,
        tableNumber: restaurantTables.number,
      })
      .from(orders)
      .leftJoin(restaurantTables, eq(restaurantTables.id, orders.tableId))
      .where(and(eq(orders.customerId, customerId), eq(orders.status, "open")))
      .orderBy(asc(orders.openedAt));
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      openedAt: r.openedAt,
      tabLabel: r.tabLabel,
      deliveryFee: r.deliveryFee,
      tableNumber: r.tableNumber ?? null,
    }));
  }

  /**
   * Histórico paginado do cliente: `closedAt DESC NULLS LAST, openedAt DESC`
   * (a comanda em aberto fica no fim) + contagem do conjunto filtrado. `from`/`to`
   * já vêm RESOLVIDOS pelo use case (bordas do dia local da loja).
   */
  async listHistoryByCustomer(
    customerId: Id,
    query: { limit: number; offset: number; from?: string; to?: string },
  ): Promise<Page<CustomerOrderHistoryRecord>> {
    const conditions: SQL[] = [eq(orders.customerId, customerId)];
    if (query.from !== undefined || query.to !== undefined) {
      if (query.from) conditions.push(gte(orders.closedAt, query.from));
      if (query.to) conditions.push(lte(orders.closedAt, query.to));
    }
    const where = and(...conditions);

    const rows = await this.tx
      .select({
        id: orders.id,
        status: orders.status,
        openedAt: orders.openedAt,
        closedAt: orders.closedAt,
        tabLabel: orders.tabLabel,
        paymentMethod: orders.paymentMethod,
        deliveryFee: orders.deliveryFee,
        tableNumber: restaurantTables.number,
      })
      .from(orders)
      .leftJoin(restaurantTables, eq(restaurantTables.id, orders.tableId))
      .where(where)
      .orderBy(sql`${orders.closedAt} DESC NULLS LAST, ${orders.openedAt} DESC`)
      .limit(query.limit)
      .offset(query.offset);
    const totalRow = await this.tx.select({ count: count() }).from(orders).where(where);

    return {
      data: rows.map((r) => ({
        id: r.id,
        status: r.status,
        openedAt: r.openedAt,
        closedAt: r.closedAt,
        tabLabel: r.tabLabel,
        paymentMethod: r.paymentMethod,
        deliveryFee: r.deliveryFee,
        tableNumber: r.tableNumber ?? null,
      })),
      total: Number(totalRow[0]?.count ?? rows.length),
    };
  }

  /**
   * Comandas fechadas do cliente com `closedAt` em `[from, to]` — só o que a
   * série de consumo agrega em JS (id/closedAt/frete), sem join e sem paginar.
   */
  async listClosedByCustomerBetween(
    customerId: Id,
    from: string,
    to: string,
  ): Promise<Array<{ id: Id; closedAt: string | null; deliveryFee: number | null }>> {
    const rows = await this.tx
      .select({ id: orders.id, closedAt: orders.closedAt, deliveryFee: orders.deliveryFee })
      .from(orders)
      .where(
        and(
          eq(orders.customerId, customerId),
          eq(orders.status, "closed"),
          gte(orders.closedAt, from),
          lte(orders.closedAt, to),
        ),
      );
    return rows.map((r) => ({ id: r.id, closedAt: r.closedAt, deliveryFee: r.deliveryFee }));
  }

  /**
   * Total e contagem de itens por comanda, numa query agrupada — mesmíssimo
   * cálculo do `itemsAggregateByOrder` original (snapshot `unit_price × quantity`,
   * excluindo `cancelled`; `itemCount` soma `quantity`, não linhas).
   */
  async aggregateItemsByOrders(orderIds: Id[]): Promise<Map<Id, { total: number; itemCount: number }>> {
    const map = new Map<Id, { total: number; itemCount: number }>();
    if (orderIds.length === 0) return map;
    const rows = await this.tx
      .select({
        orderId: orderItems.orderId,
        total: sql<number>`coalesce(sum(${orderItems.unitPrice} * ${orderItems.quantity}), 0)`,
        itemCount: sql<number>`coalesce(sum(${orderItems.quantity}), 0)`,
      })
      .from(orderItems)
      .where(and(inArray(orderItems.orderId, orderIds), sql`${orderItems.status} <> 'cancelled'`))
      .groupBy(orderItems.orderId);
    for (const r of rows) map.set(r.orderId, { total: Number(r.total), itemCount: Number(r.itemCount) });
    return map;
  }

  // -- itens --

  /** Itens crus (sem join de produto) — o que a máquina de stage/lote consome. */
  async listItemRows(orderId: Id): Promise<OrderItemRow[]> {
    const rows = await this.tx.query.orderItems.findMany({ where: eq(orderItems.orderId, orderId) });
    return rows.map(toOrderItemRow);
  }

  async listItemsWithProduct(orderId: Id): Promise<OrderItemWithProduct[]> {
    const rows = await this.tx
      .select({
        item: orderItems,
        productName: products.name,
        productImagePath: products.imagePath,
        productKitchenGroupId: products.kitchenGroupId,
      })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(eq(orderItems.orderId, orderId));
    return rows.map(({ item, productName, productImagePath, productKitchenGroupId }) => ({
      ...toOrderItemRow(item),
      productName,
      productImagePath,
      productKitchenGroupId,
    }));
  }

  async listItemsWithProductForOrders(ids: Id[]): Promise<OrderItemWithProduct[]> {
    if (ids.length === 0) return [];
    const rows = await this.tx
      .select({
        item: orderItems,
        productName: products.name,
        productImagePath: products.imagePath,
        productKitchenGroupId: products.kitchenGroupId,
      })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(inArray(orderItems.orderId, ids));
    return rows.map(({ item, productName, productImagePath, productKitchenGroupId }) => ({
      ...toOrderItemRow(item),
      productName,
      productImagePath,
      productKitchenGroupId,
    }));
  }

  async findItem(itemId: Id): Promise<OrderItemRow | null> {
    const row = await this.tx.query.orderItems.findFirst({ where: eq(orderItems.id, itemId) });
    return row ? toOrderItemRow(row) : null;
  }

  async insertItem(input: {
    orderId: Id;
    productId: Id;
    quantity: number;
    unitPrice: number;
    costPrice: number;
    selectedVariations: string;
    notes?: string | null;
    createdBy: Id;
    status: "ordered" | "ready" | "delivered" | "cancelled";
  }): Promise<OrderItemRow> {
    const [row] = await this.tx
      .insert(orderItems)
      .values({
        orderId: input.orderId,
        productId: input.productId,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        costPrice: input.costPrice,
        selectedVariations: input.selectedVariations,
        notes: input.notes ?? null,
        createdBy: input.createdBy,
        status: input.status,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "productId" });
    return toOrderItemRow(row);
  }

  /**
   * Lock otimista: o UPDATE só casa quando a `version` esperada ainda vale
   * (mesma condição de `updateItemStatusUsecase`). `null` = conflito — o use
   * case relê a linha e responde `concurrency_conflict` com a versão corrente.
   */
  async transitionItemStatus(
    itemId: Id,
    status: "ready" | "delivered",
    expectedVersion: number,
  ): Promise<OrderItemRow | null> {
    const [row] = await this.tx
      .update(orderItems)
      .set({ status, version: sql`${orderItems.version} + 1`, updatedAt: new Date().toISOString() })
      .where(and(eq(orderItems.id, itemId), eq(orderItems.version, expectedVersion)))
      .returning();
    return row ? toOrderItemRow(row) : null;
  }

  async deleteItem(itemId: Id): Promise<void> {
    await this.tx.delete(orderItems).where(eq(orderItems.id, itemId));
  }

  async cancelActiveItems(orderId: Id): Promise<void> {
    await this.tx
      .update(orderItems)
      .set({ status: "cancelled" })
      .where(and(eq(orderItems.orderId, orderId), notInArray(orderItems.status, ["delivered", "cancelled"])));
  }

  // -- linhas de pagamento (`order_payment` — pagamento fracionado) --

  async listPaymentLines(orderId: Id): Promise<OrderPaymentLineRow[]> {
    const rows = await this.tx.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    return rows.map(toPaymentLineRow);
  }

  async listPaymentLinesForOrders(ids: Id[]): Promise<OrderPaymentLineRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.tx.select().from(orderPayments).where(inArray(orderPayments.orderId, ids));
    return rows.map(toPaymentLineRow);
  }

  async findPaymentLine(id: Id): Promise<OrderPaymentLineRow | null> {
    const row = await this.tx.query.orderPayments.findFirst({ where: eq(orderPayments.id, id) });
    return row ? toPaymentLineRow(row) : null;
  }

  async insertPaymentLine(input: {
    orderId: Id;
    method: "cash" | "card" | "pix" | "other";
    amount: number;
    received: number | null;
    change: number | null;
    confirmed: boolean;
    confirmedAt: string | null;
    confirmedBy: Id | null;
    createdBy: Id;
  }): Promise<OrderPaymentLineRow> {
    const [row] = await this.tx
      .insert(orderPayments)
      .values({
        orderId: input.orderId,
        method: input.method,
        amount: input.amount,
        received: input.received,
        change: input.change,
        confirmed: input.confirmed,
        confirmedAt: input.confirmedAt,
        confirmedBy: input.confirmedBy,
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "orderId" });
    return toPaymentLineRow(row);
  }

  async updatePaymentLineReceived(
    id: Id,
    input: { received: number | null; change: number | null },
  ): Promise<OrderPaymentLineRow> {
    const [row] = await this.tx
      .update(orderPayments)
      .set({ received: input.received, change: input.change })
      .where(eq(orderPayments.id, id))
      .returning();
    if (!row) throw Errors.notFound("Pagamento");
    return toPaymentLineRow(row);
  }

  async confirmPaymentLine(
    id: Id,
    input: { confirmedAt: string; confirmedBy: Id },
  ): Promise<OrderPaymentLineRow> {
    const [row] = await this.tx
      .update(orderPayments)
      .set({ confirmed: true, confirmedAt: input.confirmedAt, confirmedBy: input.confirmedBy })
      .where(eq(orderPayments.id, id))
      .returning();
    if (!row) throw Errors.notFound("Pagamento");
    return toPaymentLineRow(row);
  }

  async deletePaymentLine(id: Id): Promise<void> {
    await this.tx.delete(orderPayments).where(eq(orderPayments.id, id));
  }

  async deletePaymentLines(ids: Id[]): Promise<void> {
    if (ids.length === 0) return;
    await this.tx.delete(orderPayments).where(inArray(orderPayments.id, ids));
  }

  /**
   * Denormalizado de exibição em `order`. Só os campos presentes no patch são
   * escritos: a confirmação de UMA linha (confirmOrderPayment) muda só o
   * carimbo, sem regravar `payment_method`.
   */
  async updatePaymentSummary(
    id: Id,
    patch: { paymentMethod?: string | null; paymentConfirmedAt: string | null; paymentConfirmedBy: Id | null },
  ): Promise<void> {
    await this.tx
      .update(orders)
      .set({
        ...(patch.paymentMethod !== undefined ? { paymentMethod: patch.paymentMethod as "cash" | "card" | "pix" | "other" } : {}),
        paymentConfirmedAt: patch.paymentConfirmedAt,
        paymentConfirmedBy: patch.paymentConfirmedBy,
      })
      .where(eq(orders.id, id));
  }
}

