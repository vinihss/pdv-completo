import { and, eq, gte, lte, or, like, sql } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { orders, orderItems, restaurantTables, customers, products } from "../infra/db/schema.js";

export async function salesReportUsecase(input: {
  dateFrom?: string;
  dateTo?: string;
  customerQuery?: string;
  productId?: string;
  limit: number;
  offset: number;
}) {
  const conditions = [eq(orders.status, "closed")];

  if (input.dateFrom) conditions.push(gte(orders.closedAt, input.dateFrom));
  if (input.dateTo) conditions.push(lte(orders.closedAt, input.dateTo + "T23:59:59.999Z"));
  if (!input.dateFrom && !input.dateTo) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    conditions.push(gte(orders.closedAt, thirtyDaysAgo));
  }

  // Busca base: comandas fechadas dentro do período
  let orderRows = await db
    .select({
      id: orders.id,
      closedAt: orders.closedAt,
      paymentMethod: orders.paymentMethod,
      tableId: orders.tableId,
      tableNumber: restaurantTables.number,
      customerId: orders.customerId,
      customerName: customers.name,
      tabLabel: orders.tabLabel,
    })
    .from(orders)
    .leftJoin(restaurantTables, eq(restaurantTables.id, orders.tableId))
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(and(...conditions));

  if (input.customerQuery) {
    const q = input.customerQuery.toLowerCase();
    orderRows = orderRows.filter(
      (o) =>
        (o.tableNumber ?? "").toLowerCase().includes(q) ||
        (o.customerName ?? "").toLowerCase().includes(q) ||
        (o.tabLabel ?? "").toLowerCase().includes(q)
    );
  }

  if (input.productId) {
    const withProduct = await db
      .selectDistinct({ orderId: orderItems.orderId })
      .from(orderItems)
      .where(eq(orderItems.productId, input.productId));
    const idsWithProduct = new Set(withProduct.map((r) => r.orderId));
    orderRows = orderRows.filter((o) => idsWithProduct.has(o.id));
  }

  // Total por comanda, a partir do snapshot unit_price (nunca o preço atual do produto)
  const totalsByOrder = new Map<string, number>();
  const paymentByOrder = new Map<string, string | null>();
  for (const o of orderRows) paymentByOrder.set(o.id, o.paymentMethod);

  if (orderRows.length > 0) {
    const orderIds = orderRows.map((o) => o.id);
    const itemRows = await db
      .select({ orderId: orderItems.orderId, unitPrice: orderItems.unitPrice, quantity: orderItems.quantity, status: orderItems.status })
      .from(orderItems)
      .where(sql`${orderItems.orderId} IN ${orderIds}`);

    for (const it of itemRows) {
      if (it.status === "cancelled") continue;
      totalsByOrder.set(it.orderId, (totalsByOrder.get(it.orderId) ?? 0) + it.unitPrice * it.quantity);
    }
  }

  const enriched = orderRows.map((o) => ({
    orderId: o.id,
    label: o.tableNumber ? `Mesa ${o.tableNumber}` : o.customerName ?? o.tabLabel ?? "—",
    closedAt: o.closedAt,
    paymentMethod: o.paymentMethod,
    total: totalsByOrder.get(o.id) ?? 0,
  }));

  // summary é agregado sobre TODO o conjunto filtrado, não sobre a página (§7.9)
  const totalRevenue = enriched.reduce((sum, o) => sum + o.total, 0);
  const orderCount = enriched.length;
  const avgTicket = orderCount > 0 ? totalRevenue / orderCount : 0;
  const byPaymentMethod: Record<string, number> = { cash: 0, card: 0, pix: 0, other: 0 };
  for (const o of enriched) {
    if (o.paymentMethod) byPaymentMethod[o.paymentMethod] = (byPaymentMethod[o.paymentMethod] ?? 0) + o.total;
  }

  const page = enriched
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
    .slice(input.offset, input.offset + input.limit);

  return {
    data: page,
    total: orderCount,
    summary: { totalRevenue, orderCount, avgTicket, byPaymentMethod },
  };
}
