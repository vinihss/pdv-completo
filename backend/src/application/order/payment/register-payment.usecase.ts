/**
 * PATCH /orders/:id/payment (legado) — adaptador sobre o modelo fracionado.
 *
 * Transforma o registro antigo (método único, sem valor) em uma única linha de
 * 100% do total. Mantém o fluxo self-service/entrega funcionando sem mudança
 * (intenção confirmed:false no checkout; confirmação confirmed:true na entrega).
 */
import type { OrderDependencies } from "../ports/order-dependencies.js";
import { Errors } from "../../../domain/errors.js";
import { computeOrderTotalInSession } from "../shared/order-totals.js";
import {
  planPaymentLines,
  upsertPaymentLines,
  type PaymentLineInput,
} from "./payment-lines.js";

export type RegisterPaymentInput = {
  orderId: string;
  userId: string;
  paymentMethod: "cash" | "card" | "pix" | "other";
  confirmed: boolean;
  /** Só cash: quanto o cliente vai entregar. Ausente = valor exato. */
  received?: number;
};

export class RegisterPaymentUseCase {
  constructor(private readonly deps: OrderDependencies) {}

  async execute(input: RegisterPaymentInput) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const settings = await this.deps.settings.get();
      const enabled: string[] = JSON.parse(settings.enabledPaymentMethods);
      if (!enabled.includes(input.paymentMethod)) throw Errors.paymentMethodDisabled();

      const order = await session.orders.findRow(input.orderId);
      if (!order) throw Errors.notFound("Comanda");
      if (order.status !== "open") throw Errors.orderNotOpen();

      const total = await computeOrderTotalInSession(session, order);
      // Intenção única de 100% do total — a mesma linha que entra por
      // planPaymentLines/upsertPaymentLines, com a mesma guarda de linha
      // confirmada (ver o comentário de upsertPaymentLines).
      const lines: PaymentLineInput[] = [
        { method: input.paymentMethod, amount: total, confirmed: input.confirmed, received: input.received },
      ];
      const { payments, reused, created } = await upsertPaymentLines(
        session,
        order,
        input.userId,
        lines,
        await planPaymentLines(session, order, lines)
      );
      await session.audit.record({
        actorId: input.userId,
        action: "payment_registered",
        orderId: input.orderId,
        details: {
          paymentMethod: input.paymentMethod,
          confirmed: input.confirmed,
          reused,
          created,
        },
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
      return payments[0];
    });
  }
}
