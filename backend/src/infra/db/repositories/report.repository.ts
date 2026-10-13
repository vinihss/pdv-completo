import { and, eq, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import {
  customers,
  deliveries,
  orderItems,
  orderPayments,
  orderRefunds,
  orders,
  products,
  restaurantTables,
  users,
} from "../schema.js";
import type {
  Id,
  ReportClosedOrderRow,
  ReportDeliveryRow,
  ReportItemRow,
  ReportOrderItemsTotalRow,
  ReportOrderSummaryRow,
  ReportPaymentRow,
  ReportRefundRow,
  ReportRepository,
} from "../../../application/ports/repositories.js";

// Relatórios gerenciais — ADIÇÃO (Onda 3D)
//
// Replica 1:1 as queries dos módulos legados `report.usecases.ts`,
// `report-overview.usecases.ts` e `report-deliveries.usecases.ts` (mesmos
// JOINs, filtros, janela default de 30 dias e agregação SQL de itens por
// comanda). A agregação em JS (totais por comanda/produto, buckets por período,
// paginação) continua nos use cases.
// ---------------------------------------------------------------------------
export class PostgresReportRepository implements ReportRepository {
  constructor(private readonly tx: Tx) {}

  /** Comandas fechadas com mesa/cliente resolvidos (LEFT JOINs) — mesma base do `salesReportUsecase`. */
  async listClosedOrders(input: { dateFrom?: string; dateTo?: string }): Promise<ReportClosedOrderRow[]> {
    const conditions = [eq(orders.status, "closed")];

    if (input.dateFrom) conditions.push(gte(orders.closedAt, input.dateFrom));
    if (input.dateTo) conditions.push(lte(orders.closedAt, input.dateTo + "T23:59:59.999Z"));
    if (!input.dateFrom && !input.dateTo) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
      conditions.push(gte(orders.closedAt, thirtyDaysAgo));
    }

    return this.tx
      .select({
        id: orders.id,
        closedAt: orders.closedAt,
        paymentMethod: orders.paymentMethod,
        tableId: orders.tableId,
        tableNumber: restaurantTables.number,
        customerId: orders.customerId,
        customerName: customers.name,
        tabLabel: orders.tabLabel,
        deliveryFee: orders.deliveryFee,
      })
      .from(orders)
      .leftJoin(restaurantTables, eq(restaurantTables.id, orders.tableId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(and(...conditions));
  }

  /** Comandas que contêm o produto (`SELECT DISTINCT order_id` — filtro `productId` do relatório de vendas). */
  async listOrderIdsByProduct(productId: Id): Promise<Id[]> {
    const rows = await this.tx
      .selectDistinct({ orderId: orderItems.orderId })
      .from(orderItems)
      .where(eq(orderItems.productId, productId));
    return rows.map((r) => r.orderId);
  }

  /** Itens das comandas (snapshot de preço/custo + quantidade + status) — a agregação em JS é do use case. */
  async listOrderItems(orderIds: Id[]): Promise<ReportItemRow[]> {
    if (orderIds.length === 0) return [];
    return this.tx
      .select({
        orderId: orderItems.orderId,
        productId: orderItems.productId,
        unitPrice: orderItems.unitPrice,
        costPrice: orderItems.costPrice,
        quantity: orderItems.quantity,
        status: orderItems.status,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIds));
  }

  /** Estornos `settled` por comanda (Bloco 4 — faturamento líquido). */
  async listSettledRefunds(orderIds: Id[]): Promise<ReportRefundRow[]> {
    if (orderIds.length === 0) return [];
    return this.tx
      .select({
        orderId: orderRefunds.orderId,
        amount: orderRefunds.amount,
      })
      .from(orderRefunds)
      .where(and(inArray(orderRefunds.orderId, orderIds), eq(orderRefunds.status, "settled")));
  }

  /** Nomes dos produtos do `byProduct` (mesma hidratação do `db.query.products.findMany` original). */
  async listProductNames(productIds: Id[]): Promise<Array<{ id: Id; name: string }>> {
    if (productIds.length === 0) return [];
    return this.tx.query.products.findMany({
      where: inArray(products.id, productIds),
      columns: { id: true, name: true },
    });
  }

  /** Linhas de `order_payment` das comandas (fracionamento por forma de pagamento). */
  async listOrderPayments(orderIds: Id[]): Promise<ReportPaymentRow[]> {
    if (orderIds.length === 0) return [];
    return this.tx
      .select({
        orderId: orderPayments.orderId,
        method: orderPayments.method,
        amount: orderPayments.amount,
        change: orderPayments.change,
      })
      .from(orderPayments)
      .where(inArray(orderPayments.orderId, orderIds));
  }

  /** Comandas fechadas com `closedAt` em `[from, to]` — `from`/`to` já são bordas UTC do dia local (use case resolve via `dayStart`/`dayEnd`). */
  async listClosedOrdersBetween(from: string, to: string): Promise<ReportOrderSummaryRow[]> {
    return this.tx
      .select({
        id: orders.id,
        closedAt: orders.closedAt,
        deliveryFee: orders.deliveryFee,
      })
      .from(orders)
      .where(and(eq(orders.status, "closed"), gte(orders.closedAt!, from), lte(orders.closedAt!, to)));
  }

  /** Soma de `unit_price × quantity` por comanda (sem `cancelled`), numa query agrupada — mesma conta de `computeOrderTotal`. */
  async listItemsTotalByOrder(orderIds: Id[]): Promise<ReportOrderItemsTotalRow[]> {
    if (orderIds.length === 0) return [];
    return this.tx
      .select({
        orderId: orderItems.orderId,
        total: sql<number>`coalesce(sum(${orderItems.unitPrice} * ${orderItems.quantity}), 0)`,
      })
      .from(orderItems)
      .where(
        and(
          inArray(orderItems.orderId, orderIds),
          // Cancelados não entram no total — mesma regra do relatório de vendas
          // e de `computeOrderTotal` (o original comparava via `<> 'cancelled'`).
          notInArray(orderItems.status, ["cancelled"]),
        ),
      )
      .groupBy(orderItems.orderId);
  }

  /** Entregas de comandas fechadas no intervalo (innerJoin `delivery`×`order` + leftJoin `user`) — base do relatório de entregas. */
  async listDeliveriesBetween(from: string, to: string): Promise<ReportDeliveryRow[]> {
    return this.tx
      .select({
        orderId: orders.id,
        status: deliveries.status,
        courierId: deliveries.courierId,
        courierName: users.name,
        deliveryFee: orders.deliveryFee,
        estimatedMinutes: deliveries.estimatedMinutes,
        dispatchedAt: deliveries.dispatchedAt,
        deliveredAt: deliveries.deliveredAt,
      })
      .from(deliveries)
      .innerJoin(orders, eq(orders.id, deliveries.orderId))
      .leftJoin(users, eq(users.id, deliveries.courierId))
      .where(
        and(
          eq(orders.status, "closed"),
          gte(orders.closedAt!, from),
          lte(orders.closedAt!, to),
        ),
      );
  }
}

