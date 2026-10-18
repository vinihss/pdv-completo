/**
 * PATCH /orders/:id/items/:itemId — muda o status de um item (ready/delivered).
 *
 * Valida a transição por modo (§7.2), o papel do usuário e a versão otimista,
 * emite os eventos de realtime e propaga o stage do pedido self-service quando
 * o último item fica pronto. Tudo na mesma transação.
 */
import { Errors } from "../../../domain/errors.js";
import type { OrderDependencies } from "../ports/order-dependencies.js";
import { emitCustomerStageChanged } from "../../self-service/customer-stage.js";

export type UpdateItemStatusInput = {
  orderId: string;
  itemId: string;
  userId: string;
  userRole: "waiter" | "kitchen" | "manager" | "courier" | "cashier";
  newStatus: "ready" | "delivered";
  expectedVersion: number;
};

export class UpdateItemStatusUseCase {
  constructor(private readonly deps: OrderDependencies) {}

  async execute(input: UpdateItemStatusInput) {
    // Último item pronto do pedido self-service muda o stage (preparing →
    // ready) — a página pública consome o evento customer.stage_changed
    // (room order:<orderId>) para atualizar a tela do cliente.
    const { updated } = await this.deps.uow.run(this.deps.tenant(), async (session) => {
      const item = await session.orders.findItem(input.itemId);
      if (!item || item.orderId !== input.orderId) throw Errors.notFound("Item");
      const settings = await this.deps.settings.get();

      // Validação de transição por modo (§7.2, kitchen_enabled)
      if (settings.kitchenEnabled) {
        if (input.newStatus === "ready" && item.status !== "ordered") throw Errors.invalidTransition();
        if (input.newStatus === "delivered" && item.status !== "ready") throw Errors.invalidTransition();
      } else {
        if (input.newStatus === "ready") throw Errors.invalidTransition("Não há estação de cozinha neste modo.");
        if (input.newStatus === "delivered" && item.status !== "ordered") throw Errors.invalidTransition();
      }
      if (item.status === "delivered") throw Errors.invalidTransition();

      // Role: ready exige kitchen/manager; delivered exige waiter/manager
      if (input.newStatus === "ready" && !["kitchen", "manager"].includes(input.userRole)) throw Errors.forbiddenRole();
      if (input.newStatus === "delivered" && !["waiter", "manager"].includes(input.userRole)) throw Errors.forbiddenRole();

      const result = await session.orders.transitionItemStatus(input.itemId, input.newStatus, input.expectedVersion);
      if (!result) {
        const current = await session.orders.findItem(input.itemId);
        throw Errors.concurrencyConflict(current?.version ?? -1);
      }

      const parentOrder = await session.orders.findRow(input.orderId);
      await session.outbox.enqueue({
        room: `table:${parentOrder?.tableId ?? input.orderId}`,
        type: "order.item.status_changed",
        aggregateId: input.orderId,
        payload: {
          orderId: input.orderId,
          itemId: input.itemId,
          status: input.newStatus,
          changedBy: input.userId,
        },
      });
      await session.outbox.enqueue({
        room: "kitchen-display",
        type: "order.item.status_changed",
        aggregateId: input.orderId,
        payload: {
          orderId: input.orderId,
          itemId: input.itemId,
          status: input.newStatus,
          changedBy: input.userId,
        },
      });

      // Só pra comanda de delivery (web/WhatsApp) — comanda de mesa não tem
      // máquina de cliente (nobody assina order:<orderId> de mesa). O stage
      // só muda de fato quando o ÚLTIMO item ativo fica pronto.
      const isSelfService = parentOrder?.channel === "web" || parentOrder?.channel === "whatsapp";
      if (isSelfService && input.newStatus === "ready") {
        const allItems = await session.orders.listItemRows(input.orderId);
        const activeItems = allItems.filter((i) => i.status !== "cancelled");
        if (activeItems.length > 0 && activeItems.every((i) => i.status === "ready" || i.status === "delivered")) {
          await emitCustomerStageChanged(session, input.orderId);
        }
      }

      const action = input.newStatus === "delivered" ? "item_delivered" : "item_ready";
      await session.audit.record({
        actorId: input.userId,
        action,
        orderId: input.orderId,
        details: { itemId: input.itemId },
      });

      return { updated: result };
    });

    return { ...updated, selectedVariations: JSON.parse(updated.selectedVariations) };
  }
}
