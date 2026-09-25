import { and, eq, gte, lte, or, like, sql, inArray } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import {
  orders,
  orderItems,
  orderPayments,
  restaurantTables,
  customers,
  products,
} from "../infra/db/schema.js";
import { round2 } from "../domain/money.js";

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
      deliveryFee: orders.deliveryFee,
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

  // Grandes totais por comanda + totais por produto, ambos sobre TODO o
  // conjunto filtrado (não a página). Margem por produto: revenue usa o
  // snapshot unit_price; custo usa o snapshot order_item.cost_price (0 em
  // itens lançados antes da feature de estoque — margem só é confiável
  // quando há custo cadastrado).
  const totalsByOrder = new Map<string, number>();
  const prodTotals = new Map<string, { qty: number; revenue: number; cost: number }>();
  const orderIds = orderRows.map((o) => o.id);

  if (orderRows.length > 0) {
    const itemRows = await db
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

    for (const it of itemRows) {
      if (it.status === "cancelled") continue;
      totalsByOrder.set(it.orderId, (totalsByOrder.get(it.orderId) ?? 0) + it.unitPrice * it.quantity);
      const cur = prodTotals.get(it.productId) ?? { qty: 0, revenue: 0, cost: 0 };
      cur.qty += it.quantity;
      cur.revenue += it.unitPrice * it.quantity;
      cur.cost += (it.costPrice ?? 0) * it.quantity;
      prodTotals.set(it.productId, cur);
    }
  }

  const productIds = [...prodTotals.keys()];
  const productRows = productIds.length
    ? await db.query.products.findMany({ where: inArray(products.id, productIds), columns: { id: true, name: true } })
    : [];
  const nameMap = new Map(productRows.map((p) => [p.id, p.name]));
  const byProduct = [...prodTotals.entries()]
    .map(([productId, t]) => {
      const revenue = round2(t.revenue);
      const cost = round2(t.cost);
      return {
        productId,
        name: nameMap.get(productId) ?? "—",
        quantity: t.qty,
        revenue,
        cost,
        profit: round2(revenue - cost),
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  // Pagamento fracionado: o detalhamento por forma vem das linhas de
  // order_payment (cada método com seu valor). Comandas antigas (pré-order_payment)
  // caem no denormalizado orders.payment_method pra não sumir do relatório.
  let paymentRows: Array<{ orderId: string; method: string | null; amount: number; change: number | null }> = [];
  if (orderIds.length > 0) {
    paymentRows = await db
      .select({
        orderId: orderPayments.orderId,
        method: orderPayments.method,
        amount: orderPayments.amount,
        change: orderPayments.change,
      })
      .from(orderPayments)
      .where(inArray(orderPayments.orderId, orderIds));
  }

  const paidByOrder = new Map<string, number>();
  const methodsByOrder = new Map<string, string[]>();
  const byPaymentMethod: Record<string, number> = { cash: 0, card: 0, pix: 0, other: 0 };
  let changeTotal = 0;

  for (const p of paymentRows) {
    paidByOrder.set(p.orderId, (paidByOrder.get(p.orderId) ?? 0) + p.amount);
    if (p.method) {
      const byId = methodsByOrder.get(p.orderId) ?? [];
      if (!byId.includes(p.method)) methodsByOrder.set(p.orderId, [...byId, p.method]);
      byPaymentMethod[p.method] = (byPaymentMethod[p.method] ?? 0) + p.amount;
    }
    if (p.change) changeTotal += p.change;
  }

  // Comandas sem splits (registro antigo) atribuem o total ao payment_method
  // denormalizado — mantém o relatório correto em histórico pré-feature.
  for (const o of orderRows) {
    const total = (totalsByOrder.get(o.id) ?? 0) + (o.deliveryFee ?? 0);
    const paid = round2(paidByOrder.get(o.id) ?? 0);
    const remainder = round2(total - paid);
    if (remainder > 0.004) {
      const m: string = o.paymentMethod ?? "other";
      byPaymentMethod[m] = (byPaymentMethod[m] ?? 0) + remainder;
      const byId = methodsByOrder.get(o.id) ?? [];
      if (!byId.includes(m)) methodsByOrder.set(o.id, [...byId, m]);
    }
  }

  for (const key of Object.keys(byPaymentMethod)) {
    byPaymentMethod[key] = round2(byPaymentMethod[key]);
  }
  const changeTotalRound = round2(changeTotal);

  const enriched = orderRows.map((o) => ({
    orderId: o.id,
    label: o.tableNumber ? `Mesa ${o.tableNumber}` : o.customerName ?? o.tabLabel ?? "—",
    closedAt: o.closedAt,
    paymentMethod: methodsByOrder.get(o.id)?.join(" + ") ?? o.paymentMethod ?? "—",
    total: (totalsByOrder.get(o.id) ?? 0) + (o.deliveryFee ?? 0),
  }));

  // summary é agregado sobre TODO o conjunto filtrado, não sobre a página (§7.9)
  const totalRevenue = round2(enriched.reduce((sum, o) => sum + o.total, 0));
  const orderCount = enriched.length;
  const avgTicket = orderCount > 0 ? round2(totalRevenue / orderCount) : 0;

  const page = enriched
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
    .slice(input.offset, input.offset + input.limit);

  return {
    data: page,
    total: orderCount,
    summary: {
      totalRevenue,
      orderCount,
      avgTicket,
      byPaymentMethod,
      byProduct,
      changeTotal: changeTotalRound,
    },
  };
}