/**
 * PATCH /orders/:id/cancel — cancela a comanda sem venda.
 *
 * Diferente do fechamento: não exige pagamento nem itens entregues. Estorna o
 * dinheiro confirmado como sangria, devolve o estoque pelo ledger e propaga o
 * cancelamento pra entrega (tudo na mesma transação).
 *
 * Só existe porque a fase de delivery expôs um buraco que já existia pro app
 * inteiro: nenhum caminho fechava um pedido que não terminasse em venda (ex:
 * entrega marcada "failed" — deliveries.status vira "failed", mas
 * orders.status ficava "open" pra sempre, sem paymentMethod nem itens
 * "delivered", então closeOrderUsecase nunca aceitaria).
 */
import { Errors } from "../../../domain/errors.js";
import { round2 } from "../../../domain/money.js";
import { canTransitionDelivery } from "../../../domain/customer-order-state.js";
import type { OrderDependencies } from "../ports/order-dependencies.js";
import { applyStockMovement } from "../../stock/stock.usecases.js";
import { emitCustomerStageChanged } from "../../self-service/customer-stage.js";

export type CancelOrderInput = {
  orderId: string;
  userId: string;
  reason: string;
};

export class CancelOrderUseCase {
  constructor(private readonly deps: OrderDependencies) {}

  async execute(input: CancelOrderInput) {
    const cancelled = await this.deps.uow.run(this.deps.tenant(), async (session) => {
      const order = await session.orders.findRow(input.orderId);
      if (!order) throw Errors.notFound("Comanda");
      if (order.status !== "open") throw Errors.orderNotOpen();

      // Estorno: dinheiro confirmado entrou na gaveta na confirmação; cancelar
      // a venda devolve esse dinheiro. A reversão vira uma sangria automática
      // no caixa corrente (`ref_order_id` para rastrear) e — coerente com o
      // bloqueio de dinheiro sem caixa — exige sessão aberta. A linha de
      // pagamento permanece confirmada: os relatórios mostram a venda e a
      // sangria de reversão, efeito líquido zero.
      const cashPaid = (await session.orders.listPaymentLines(input.orderId)).filter(
        (p) => p.method === "cash" && p.confirmed
      );
      const refund = round2(cashPaid.reduce((acc, p) => acc + p.amount, 0));
      if (refund > 0) {
        // FOR UPDATE: o estorno gera sangria automática que reduz o saldo do
        // caixa. Sem o lock, dois cancelamentos concorrentes poderiam ambos ler
        // o drawer como aberto e gerar sangrias que, somadas, excederiam o
        // saldo disponível. O lock serializa o acesso à linha aberta.
        const drawer = await session.cashFlow.findOpenForUpdate();
        if (!drawer) throw Errors.cashRefundRequiresOpenDrawer();
        const movement = await session.cashFlow.recordMovement({
          drawerId: drawer.id,
          actorId: input.userId,
          type: "sangria",
          amount: refund,
          note: `Estorno comanda ${order.tabLabel ?? order.id}`,
          refOrderId: input.orderId,
        });
        await session.audit.record({
          actorId: input.userId,
          action: "cash_drawer_sangria",
          orderId: input.orderId,
          details: {
            movementId: movement.id,
            drawerId: drawer.id,
            amount: movement.amount,
            reason: input.reason,
          },
        });
        await session.outbox.enqueue({
          room: "cash-drawer",
          type: "cash_drawer.sangria",
          aggregateId: drawer.id,
          payload: { drawerId: drawer.id, amount: movement.amount, refOrderId: input.orderId },
        });
      }

      await session.orders.cancelActiveItems(input.orderId);

      // Estorno de estoque da comanda inteira: todo item que consumiu stock
      // (movimento 'sale' com order_id) devolve o volume como 'refund'. Itens
      // entregues também são estornados aqui — o consumo já aconteceu no
      // lançamento, e a venda não se concretizou. Sempre baseado no ledger.
      const sales = await session.stock.listSalesMovementsForOrder(input.orderId);
      for (const sale of sales) {
        await applyStockMovement(session, {
          productId: sale.productId,
          type: "refund",
          quantityDelta: -sale.quantityDelta,
          orderId: input.orderId,
          orderItemId: sale.orderItemId,
          note: "Comanda cancelada",
          createdBy: input.userId,
        });
      }

      const result = await session.orders.markCancelled(input.orderId, input.reason);

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
        type: "order.cancelled",
        aggregateId: order.id,
        payload: { orderId: order.id, tableId: order.tableId },
      });
      await session.outbox.enqueue({
        room: "kitchen-display",
        type: "order.cancelled",
        aggregateId: order.id,
        payload: { orderId: order.id, tableId: order.tableId },
      });

      // Propagação do cancelamento pra entrega: comanda cancelada não pode
      // deixar a entrega órfã (awaiting/out_for_delivery pra sempre no painel
      // do entregador, cliente em "Pedido recebido" eterno — inconsistência
      // que o fechamento já fazia. Mesma
      // transação da escrita de domínio (AGENTS.md). "delivered" não muda —
      // comanda com entrega concluída está fechada e nunca chega aqui
      // (orderNotOpen).
      const delivery = await session.deliveries.findByOrder(input.orderId);
      if (delivery && delivery.status !== "delivered" && canTransitionDelivery(delivery.status, "cancelled")) {
        await session.deliveries.transition(delivery.id, "cancelled");
        await session.outbox.enqueue({
          room: "deliveries",
          type: "delivery.status_changed",
          aggregateId: delivery.id,
          payload: {
            id: delivery.id,
            orderId: input.orderId,
            courierId: delivery.courierId,
            address: delivery.address,
            status: "cancelled",
            dispatchedAt: delivery.dispatchedAt,
            deliveredAt: delivery.deliveredAt,
            notes: delivery.notes,
          },
        });
        await emitCustomerStageChanged(session, input.orderId);
      }

      await session.audit.record({
        actorId: input.userId,
        action: "order_cancelled",
        orderId: input.orderId,
        details: { reason: input.reason },
      });
      return result;
    });

    await this.deps.cache.invalidatePrefix("reports:sales:");
    return cancelled;
  }
}
