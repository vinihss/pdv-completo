/**
 * DELETE /orders/:id/items/:itemId — remove um item da comanda.
 *
 * Com cozinha, item entregue é imutável. Estorna o estoque pelo ledger
 * (movimento 'sale' vinculado) e emite os eventos de realtime na mesma
 * transação.
 */
import { Errors } from "../../../domain/errors.js";
import type { OrderDependencies } from "../ports/order-dependencies.js";
import { applyStockMovement } from "../../stock/stock.usecases.js";

export type DeleteItemInput = {
  orderId: string;
  itemId: string;
  userId: string;
};

export class DeleteItemUseCase {
  constructor(private readonly deps: OrderDependencies) {}

  async execute(input: DeleteItemInput) {
    await this.deps.uow.run(this.deps.tenant(), async (session) => {
      const item = await session.orders.findItem(input.itemId);
      if (!item || item.orderId !== input.orderId) throw Errors.notFound("Item");
      const settings = await this.deps.settings.get();
      // Modo sem cozinha: a comanda não controla status — item já entra entregue,
      // então exclusão por engano continua permitida. Com cozinha, item entregue é imutável.
      if (settings.kitchenEnabled && item.status === "delivered") throw Errors.itemAlreadyDelivered();

      // Estorno de estoque: se o item consumiu stock no lançamento (movimento
      // 'sale' vinculado ao item existe), devolve o mesmo volume como 'refund'.
      // Baseado no ledger (e não no flag atual do produto) — a decisão de
      // repor é "houve consumo", então o ledger continua consistente mesmo se
      // o produto deixou de rastrear estoque depois.
      const sales = await session.stock.listSalesMovementsForItem(input.itemId);
      for (const sale of sales) {
        await applyStockMovement(session, {
          productId: item.productId,
          type: "refund",
          quantityDelta: -sale.quantityDelta, // sale é negativo → refund positivo
          orderId: input.orderId,
          orderItemId: input.itemId,
          note: "Item removido",
          createdBy: input.userId,
        });
      }

      await session.orders.deleteItem(input.itemId);
      await session.audit.record({
        actorId: input.userId,
        action: "item_removed",
        orderId: input.orderId,
        details: { itemId: input.itemId, name: item.productId },
      });
      // 1.8 — item removido em um terminal precisa sumir dos demais (garçom/gerente
      // assinam "kitchen-display"; "table:{id}" não é assinado por ninguém).
      await session.outbox.enqueue({
        room: `table:${item.orderId}`,
        type: "order.item.removed",
        aggregateId: input.orderId,
        payload: { orderId: input.orderId, itemId: input.itemId },
      });
      await session.outbox.enqueue({
        room: "kitchen-display",
        type: "order.item.removed",
        aggregateId: input.orderId,
        payload: { orderId: input.orderId, itemId: input.itemId },
      });
    });
  }
}
