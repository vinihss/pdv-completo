/**
 * PATCH /orders/:id/payments/:paymentId — confirma uma linha de pagamento.
 *
 * Guarda de caixa aberto para dinheiro confirmado (FOR UPDATE) e, com a
 * comanda toda confirmada, regrava o resumo denormalizado.
 */
import type { OrderDependencies } from "../ports/order-dependencies.js";
import { Errors } from "../../../domain/errors.js";
import { serializePayment } from "../shared/order-serializer.js";
import { requireOpenDrawerForCash } from "./payment-lines.js";

export type ConfirmOrderPaymentInput = {
  orderId: string;
  paymentId: string;
  userId: string;
};

export class ConfirmOrderPaymentUseCase {
  constructor(private readonly deps: OrderDependencies) {}

  async execute(input: ConfirmOrderPaymentInput) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const order = await session.orders.findRow(input.orderId);
      if (!order) throw Errors.notFound("Comanda");
      if (order.status !== "open") throw Errors.orderNotOpen();

      const payment = await session.orders.findPaymentLine(input.paymentId);
      if (!payment || payment.orderId !== input.orderId) throw Errors.notFound("Pagamento");
      if (payment.confirmed) return serializePayment(payment);
      await requireOpenDrawerForCash(session, payment.method, true);

      const result = await session.orders.confirmPaymentLine(input.paymentId, {
        confirmedAt: new Date().toISOString(),
        confirmedBy: input.userId,
      });

      const all = await session.orders.listPaymentLines(input.orderId);
      if (all.length > 0 && all.every((p) => p.confirmed)) {
        await session.orders.updatePaymentSummary(input.orderId, {
          paymentConfirmedAt: new Date().toISOString(),
          paymentConfirmedBy: input.userId,
        });
      }

      await session.audit.record({
        actorId: input.userId,
        action: "payment_confirmed",
        orderId: input.orderId,
        details: { paymentId: input.paymentId, method: payment.method },
      });
      await session.outbox.enqueue({
        room: `table:${order.tableId ?? order.id}`,
        type: "order.payment_changed",
        aggregateId: input.orderId,
        payload: { orderId: input.orderId, paymentId: input.paymentId, confirmed: true },
      });
      await session.outbox.enqueue({
        room: "cash-drawer",
        type: "order.payment_changed",
        aggregateId: input.orderId,
        payload: { orderId: input.orderId, paymentId: input.paymentId, confirmed: true },
      });
      await session.outbox.enqueue({
        room: "kitchen-display",
        type: "order.payment_changed",
        aggregateId: input.orderId,
        payload: { orderId: input.orderId, paymentId: input.paymentId, confirmed: true },
      });
      return serializePayment(result);
    });
  }
}
