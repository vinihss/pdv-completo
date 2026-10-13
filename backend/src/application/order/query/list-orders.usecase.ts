/**
 * GET /orders — lista de comandas com itens, pagamentos e entregas.
 *
 * Leitura em lote (uma query por coleção, não uma por comanda): a lista e o
 * detalhe precisam devolver a mesma coisa, porque a tela da comanda abre a
 * partir do objeto que está na lista.
 */
import type { OrderDependencies } from "../ports/order-dependencies.js";
import type {
  OrderItemWithProduct,
  OrderPaymentLineRow,
} from "../../ports/repositories.js";
import {
  serializeDelivery,
  serializeItemWithRefs,
  serializePayment,
} from "../shared/order-serializer.js";

export type ListOrdersInput = {
  status?: "open" | "closed";
  limit: number;
  offset: number;
};

export class ListOrdersUseCase {
  constructor(private readonly deps: OrderDependencies) {}

  async execute(input: ListOrdersInput) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const page = await session.orders.listRows({
        status: input.status,
        limit: input.limit,
        offset: input.offset,
      });
      const rows = page.data;
      if (rows.length === 0) return { data: [], total: page.total };

      const orderIds = rows.map((o) => o.id);

      const itemsWithProducts = await session.orders.listItemsWithProductForOrders(orderIds);
      const allPayments = await session.orders.listPaymentLinesForOrders(orderIds);

      // Uma leitura em lote, não uma por comanda. A lista e o detalhe precisam
      // devolver a mesma coisa: a tela da comanda abre a partir do objeto que está
      // na lista, então se `delivery` viesse só do detalhe o endereço só apareceria
      // depois da primeira recarga.
      const allDeliveries = await session.deliveries.listByOrderIds(orderIds);

      const tableIds = [...new Set(rows.map((o) => o.tableId).filter(Boolean))] as string[];
      const customerIds = [...new Set(rows.map((o) => o.customerId).filter(Boolean))] as string[];

      const tables = tableIds.length > 0 ? await session.catalog.listTablesByIds(tableIds) : [];
      const customerRows = customerIds.length > 0 ? await session.customers.findByIds(customerIds) : [];

      const tableMap = new Map(tables.map((t) => [t.id, t]));
      const customerMap = new Map(customerRows.map((c) => [c.id, c]));

      const itemsByOrder = new Map<string, OrderItemWithProduct[]>();
      for (const row of itemsWithProducts) {
        const list = itemsByOrder.get(row.orderId) ?? [];
        list.push(row);
        itemsByOrder.set(row.orderId, list);
      }

      const paymentsByOrder = new Map<string, OrderPaymentLineRow[]>();
      for (const p of allPayments) {
        const list = paymentsByOrder.get(p.orderId) ?? [];
        list.push(p);
        paymentsByOrder.set(p.orderId, list);
      }

      const deliveryByOrderId = new Map(allDeliveries.map((d) => [d.orderId, d]));
      const deliveryOf = (orderId: string) => {
        const d = deliveryByOrderId.get(orderId);
        return d ? serializeDelivery(d) : null;
      };

      const data = rows.map((order) => ({
        id: order.id,
        status: order.status,
        tableId: order.tableId,
        tableNumber: order.tableId ? tableMap.get(order.tableId)?.number ?? null : null,
        customerId: order.customerId,
        customerName: order.customerId ? customerMap.get(order.customerId)?.name ?? null : null,
        customerPhone: order.customerId ? customerMap.get(order.customerId)?.phone ?? null : null,
        tabLabel: order.tabLabel,
        waiterId: order.waiterId,
        channel: order.channel,
        externalRef: order.externalRef,
        deliveryFee: order.deliveryFee,
        cancelReason: order.cancelReason,
        notes: order.notes ?? null,
        paymentMethod: order.paymentMethod,
        paymentConfirmedAt: order.paymentConfirmedAt,
        paymentConfirmedBy: order.paymentConfirmedBy,
        openedAt: order.openedAt,
        closedAt: order.closedAt,
        delivery: deliveryOf(order.id),
        items: (itemsByOrder.get(order.id) ?? []).map(serializeItemWithRefs),
        payments: (paymentsByOrder.get(order.id) ?? []).map(serializePayment),
      }));

      return { data, total: page.total };
    });
  }
}
