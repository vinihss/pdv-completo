/**
 * PUT /orders/:id/payments — define o pagamento fracionado da comanda.
 *
 * Valida formas habilitadas, a fase de leitura (`planPaymentLines`) e a soma
 * contra o total, e persiste. A serialização do detalhe fica fora da transação.
 */
import { Errors } from "../../../domain/errors.js";
import { round2, moneyEq } from "../../../domain/money.js";
import type { OrderDependencies } from "../ports/order-dependencies.js";
import { computeOrderTotalInSession } from "../shared/order-totals.js";
import { serializeOrderOutside } from "../shared/order-serializer.js";
import {
  planPaymentLines,
  upsertPaymentLines,
  type PaymentLineInput,
} from "./payment-lines.js";

export type SetOrderPaymentsInput = {
  orderId: string;
  userId: string;
  payments: PaymentLineInput[];
};

export class SetOrderPaymentsUseCase {
  constructor(private readonly deps: OrderDependencies) {}

  async execute(input: SetOrderPaymentsInput) {
    await this.deps.uow.run(this.deps.tenant(), async (session) => {
      const settings = await this.deps.settings.get();
      const enabled: string[] = JSON.parse(settings.enabledPaymentMethods);
      if (input.payments.length === 0) {
        throw Errors.validationFailed({ field: "payments", reason: "informe ao menos uma forma de pagamento" });
      }

      const order = await session.orders.findRow(input.orderId);
      if (!order) throw Errors.notFound("Comanda");
      if (order.status !== "open") throw Errors.orderNotOpen();

      for (const p of input.payments) {
        if (!enabled.includes(p.method)) throw Errors.paymentMethodDisabled();
        if (!(p.amount > 0)) throw Errors.validationFailed({ field: "amount", reason: "valor deve ser maior que zero" });
      }

      // Guarda de remoção ANTES da conferência da soma (ver planPaymentLines):
      // linha confirmada fora da lista é "exige estorno", não "soma errada".
      const plan = await planPaymentLines(session, order, input.payments);
      const total = await computeOrderTotalInSession(session, order);
      const sum = round2(input.payments.reduce((acc, p) => acc + p.amount, 0));
      if (!moneyEq(sum, total)) throw Errors.invalidPaymentTotal();

      const { payments, reused, created } = await upsertPaymentLines(session, order, input.userId, input.payments, plan);
      // `reused` separa o pagamento que a gaveta já conta do que é novo: um PUT
      // que reenvia as mesmas linhas não pode aparecer no log como tudo novo.
      await session.audit.record({
        actorId: input.userId,
        action: "payment_registered",
        orderId: input.orderId,
        details: { payments, reused, created },
      });
      await session.outbox.enqueue({
        room: `table:${order.tableId ?? order.id}`,
        type: "order.payment_changed",
        aggregateId: input.orderId,
        payload: { orderId: input.orderId, payments },
      });
      await session.outbox.enqueue({
        room: "cash-drawer",
        type: "order.payment_changed",
        aggregateId: input.orderId,
        payload: { orderId: input.orderId, payments },
      });
      await session.outbox.enqueue({
        room: "kitchen-display",
        type: "order.payment_changed",
        aggregateId: input.orderId,
        payload: { orderId: input.orderId, payments },
      });
    });

    return serializeOrderOutside(this.deps, input.orderId);
  }
}
