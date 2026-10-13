/**
 * POST /orders/:id/items — lança itens na comanda.
 *
 * Valida produto/estoque, define o status de entrada por estação (§7.2),
 * debita o ledger e emite os eventos de realtime na MESMA transação. A
 * impressão automática da cozinha é pós-commit (fire-and-forget).
 */
import { Errors } from "../../../domain/errors.js";
import type { OrderDependencies } from "../ports/order-dependencies.js";
import { serializeItem } from "../shared/order-serializer.js";
import { applyStockMovement, INVENTORY_ROOM } from "../../stock/stock.usecases.js";

export type AddItemsInput = {
  orderId: string;
  userId: string;
  items: Array<{
    productId: string;
    quantity: number;
    selectedVariations?: Record<string, string | string[]>;
    notes?: string;
  }>;
};

export class AddItemsUseCase {
  constructor(private readonly deps: OrderDependencies) {}

  async execute(input: AddItemsInput) {
    const result = await this.deps.uow.run(this.deps.tenant(), async (session) => {
      const order = await session.orders.findRow(input.orderId);
      if (!order) throw Errors.notFound("Comanda");
      if (order.status !== "open") throw Errors.orderNotOpen();

      const settings = await this.deps.settings.get();

      const createdItems: ReturnType<typeof serializeItem>[] = [];
      for (const line of input.items) {
        const product = await session.catalog.findProductForOrdering(line.productId);
        if (!product || !product.active) {
          throw Errors.validationFailed({ productId: line.productId, reason: "inativo ou inexistente" });
        }
        // Estoque (003/0016): com a feature global ligada E produto rastreando,
        // o saldo do ledger é o teto — lançar mais que disponível bloqueia a
        // comanda inteira (a transação inteira faz rollback no throw). Requer
        // saldo do ledger, nunca coluna cacheada.
        const deductsStock = settings.inventoryEnabled && product.trackStock;
        if (deductsStock) {
          const available = await session.stock.balance(product.id);
          if (available < line.quantity) throw Errors.insufficientStock(product.id, product.name, available);
        }
        // Status de entrada por estação/modo (§7.2, kitchen_enabled):
        // - sem cozinha (pub): item já entra entregue — a comanda não controla
        //   preparo/entrega e não exige confirmação do garçom;
        // - com cozinha + grupo de produção: entra na fila da estação (ordered);
        // - com cozinha sem grupo (bar/copa): entra pronto (ready) — só falta entregar.
        const hasStation = settings.kitchenEnabled && Boolean(product.kitchenGroupId);
        const initialStatus = !settings.kitchenEnabled ? "delivered" : hasStation ? "ordered" : "ready";
        const created = await session.orders.insertItem({
          orderId: input.orderId,
          productId: line.productId,
          quantity: line.quantity,
          unitPrice: product.price, // snapshot — nunca referência viva
          // Snapshot do custo no lançamento (margem): com a feature global e
          // compras ligadas, usa a média móvel do ledger naquele instante;
          // senão, o cost_price manual do cadastro (comportamento 0016).
          costPrice:
            settings.inventoryEnabled && settings.purchaseEnabled && product.trackStock
              ? (await session.stock.movingAverage(product.id, product.costPrice)).avg
              : product.costPrice,
          selectedVariations: JSON.stringify(line.selectedVariations ?? {}),
          notes: line.notes ?? null,
          createdBy: input.userId,
          status: initialStatus,
        });
        const serialized = serializeItem(created, {
          name: product.name,
          imagePath: product.imagePath,
          kitchenGroupId: product.kitchenGroupId,
        });
        createdItems.push(serialized);

        // Débito do estoque no mesmo commit do item (rollback garante que item
        // e saldo nunca divergam). Eventos stock.movement/stock.low vão pro
        // room "inventory" — quem assina (aba Estoque do gerente) atualiza.
        if (deductsStock) {
          const { balance } = await applyStockMovement(session, {
            productId: product.id,
            type: "sale",
            quantityDelta: -line.quantity,
            orderId: input.orderId,
            orderItemId: created.id,
            createdBy: input.userId,
          });
          if (product.trackStock && product.lowStockThreshold > 0 && balance <= product.lowStockThreshold) {
            await session.outbox.enqueue({
              room: INVENTORY_ROOM,
              type: "stock.low",
              aggregateId: product.id,
              payload: {
                productId: product.id,
                name: product.name,
                quantity: balance,
                threshold: product.lowStockThreshold,
              },
            });
          }
        }

        await session.outbox.enqueue({
          room: `table:${order.tableId ?? order.id}`,
          type: "order.item.created",
          aggregateId: input.orderId,
          payload: { orderId: input.orderId, item: serialized },
        });
        // Roteamento por estação: só entra na fila da cozinha quando há cozinha
        // E o produto tem grupo de produção. Bar/copa e modo pub não emitem.
        if (hasStation) {
          await session.outbox.enqueue({
            room: "kitchen-display",
            type: "order.item.created",
            aggregateId: input.orderId,
            payload: { orderId: input.orderId, item: serialized },
          });
        }
      }

      await session.audit.record({
        actorId: input.userId,
        action: "item_added",
        orderId: input.orderId,
        details: { items: createdItems },
      });
      return { createdItems, settings };
    });

    // Impressão automática da cozinha (pós-commit, fire-and-forget): só quando
    // as duas flags estão ligadas E o modo cozinha está ativo. O daemon tem
    // fila de retry própria; falha aqui nunca quebra o lançamento.
    if (result.settings.printerEnabled && result.settings.printerAutoPrint && result.settings.kitchenEnabled) {
      this.deps.printer
        .printKitchenOrder(input.orderId)
        .catch((err) => console.error("falha ao imprimir comanda na cozinha:", err));
    }

    return result.createdItems;
  }
}
