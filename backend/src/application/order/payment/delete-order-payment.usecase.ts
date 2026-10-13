/**
 * DELETE /orders/:id/payments/:paymentId — remove uma linha não confirmada.
 *
 * Linha confirmada é recusada: estornar exige o caminho explícito (gaveta).
 */
import type { OrderDependencies } from "../ports/order-dependencies.js";
import { Errors } from "../../../domain/errors.js";

export type DeleteOrderPaymentInput = {
  orderId: string;
  paymentId: string;
  userId: string;
};

export class DeleteOrderPaymentUseCase {
  constructor(private readonly deps: OrderDependencies) {}

  async execute(input: DeleteOrderPaymentInput) {
    await this.deps.uow.run(this.deps.tenant(), async (session) => {
      const order = await session.orders.findRow(input.orderId);
      if (!order) throw Errors.notFound("Comanda");
      if (order.status !== "open") throw Errors.orderNotOpen();

      const payment = await session.orders.findPaymentLine(input.paymentId);
      if (!payment || payment.orderId !== input.orderId) throw Errors.notFound("Pagamento");
      if (payment.confirmed) throw Errors.invalidTransition("Pagamento já confirmado não pode ser removido.");
      await session.orders.deletePaymentLine(input.paymentId);
      await session.audit.record({
        actorId: input.userId,
        action: "payment_removed",
        orderId: input.orderId,
        details: { paymentId: input.paymentId, method: payment.method },
      });
      await session.outbox.enqueue({
        room: `table:${order.tableId ?? order.id}`,
        type: "order.payment_changed",
        aggregateId: input.orderId,
        payload: { orderId: input.orderId },
      });
      await session.outbox.enqueue({
        room: "cash-drawer",
        type: "order.payment_changed",
        aggregateId: input.orderId,
        payload: { orderId: input.orderId },
      });
      await session.outbox.enqueue({
        room: "kitchen-display",
        type: "order.payment_changed",
        aggregateId: input.orderId,
        payload: { orderId: input.orderId },
      });
    });
  }
}
