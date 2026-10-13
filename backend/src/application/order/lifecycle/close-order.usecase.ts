/**
 * PATCH /orders/:id/close — fecha a comanda quitada.
 *
 * Exige todos os itens entregues/cancelados e o pagamento fracionado fechando
 * com o total. Libera a mesa, emite os eventos e invalida o cache de vendas.
 */
import { Errors } from "../../../domain/errors.js";
import { round2, moneyEq } from "../../../domain/money.js";
import type { OrderDependencies } from "../ports/order-dependencies.js";
import { computeOrderTotalInSession } from "../shared/order-totals.js";
import { serializePayment } from "../shared/order-serializer.js";

export type CloseOrderInput = {
  orderId: string;
  userId: string;
};

export class CloseOrderUseCase {
  constructor(private readonly deps: OrderDependencies) {}

  async execute(input: CloseOrderInput) {
    const closed = await this.deps.uow.run(this.deps.tenant(), async (session) => {
      const order = await session.orders.findRow(input.orderId);
      if (!order) throw Errors.notFound("Comanda");
      if (order.status !== "open") throw Errors.orderNotOpen();

      const pending = (await session.orders.listItemsWithProduct(input.orderId)).filter(
        (it) => it.status !== "delivered" && it.status !== "cancelled"
      );
      if (pending.length > 0) {
        throw Errors.pendingItems(
          pending.map((it) => ({
            id: it.id,
            name: it.productName,
            quantity: it.quantity,
            status: it.status,
          }))
        );
      }

      // Pagamento fracionado: exige ao menos uma linha, todas confirmadas e a
      // soma conferindo com o total (evita fechar com "intenção" de Pix ainda
      // não recebida, ou com divisão que não cobre a conta).
      const payments = await session.orders.listPaymentLines(input.orderId);
      if (payments.length === 0) throw Errors.paymentNotRegistered();
      if (payments.some((p) => !p.confirmed)) throw Errors.paymentNotConfirmed();

      const total = await computeOrderTotalInSession(session, order);
      const paid = round2(payments.reduce((acc, p) => acc + p.amount, 0));
      if (!moneyEq(paid, total)) throw Errors.invalidPaymentTotal();

      const result = await session.orders.markClosed(input.orderId);

      if (order.tableId) {
        await session.catalog.releaseTable(order.tableId);
        await session.outbox.enqueue({
          room: `table:${order.tableId}`,
          type: "table.status_changed",
          aggregateId: order.tableId,
          payload: { tableId: order.tableId, status: "free" },
        });
      }

      await session.outbox.enqueue({
        room: `table:${order.tableId ?? order.id}`,
        type: "order.closed",
        aggregateId: order.id,
        payload: { orderId: order.id, tableId: order.tableId },
      });
      // 1.2 — comanda fechada em outro terminal deve sumir da lista do garçom
      // (useOrders assina "kitchen-display" e remove a comanda ao receber isso).
      await session.outbox.enqueue({
        room: "kitchen-display",
        type: "order.closed",
        aggregateId: order.id,
        payload: { orderId: order.id, tableId: order.tableId },
      });

      await session.audit.record({
        actorId: input.userId,
        action: "order_closed",
        orderId: input.orderId,
        details: { payments: payments.map(serializePayment) },
      });
      return result;
    });

    await this.deps.cache.invalidatePrefix("reports:sales:");
    return closed;
  }
}
