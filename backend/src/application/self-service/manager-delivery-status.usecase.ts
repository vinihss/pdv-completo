/**
 * Edição de status de entrega pelo GERENTE.
 *
 * Existe separada do `delivery.usecases.ts` (mesmo domínio, mesma
 * `DELIVERY_ROOM`) por um motivo concreto: o pedaço compartilhado com o
 * `deliverDeliveryUsecase` — marcar itens como entregues e fechar a comanda —
 * precisa morar num lugar que os dois importem sem criar ciclo.
 * `delivery.usecases.ts` importa a impressora e o notificador do WhatsApp, que
 * aqui não têm nada a ver com editar status.
 */
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { deliveries, orderItems, orders } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { canTransitionDelivery, type DeliveryStatus } from "../../domain/customer-order-state.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";
import { emitCustomerStageChangedTx } from "./customer-stage.js";
import { registerPaymentUsecase, closeOrderUsecase, getSettings } from "../order/order.usecases.js";
import { printCourierOrder } from "../../integrations/printer/printer.usecases.js";

const DELIVERY_ROOM = "deliveries";

function serialize(d: typeof deliveries.$inferSelect) {
  return {
    id: d.id,
    orderId: d.orderId,
    courierId: d.courierId,
    address: d.address,
    status: d.status,
    createdAt: d.createdAt,
    dispatchedAt: d.dispatchedAt,
    deliveredAt: d.deliveredAt,
    notes: d.notes,
  };
}

/**
 * Consequências de a entrega ter sido concluída: itens como `delivered` e
 * comanda fechada (é o que faz o pedido entrar nos relatórios — todos contam
 * só `orders.status = 'closed'`).
 *
 * Sem isto, um pedido entregue ficaria aberto para sempre: `order_item` não
 * chega a "delivered" numa entrega (não há garçom servindo mesa) e
 * `closeOrderUsecase` exige itens entregues + pagamento registrado.
 *
 * Os passos são atômicos um a um, não numa transação única — mesmo padrão de
 * composição sequencial já usado em `createSelfServiceOrderUsecase` e no
 * `deliverDeliveryUsecase`.
 */
export async function closeOrderAfterDelivery(orderId: string, userId: string): Promise<void> {
  await db
    .update(orderItems)
    .set({ status: "delivered" })
    .where(and(eq(orderItems.orderId, orderId), notInArray(orderItems.status, ["delivered", "cancelled"])));

  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (order?.paymentMethod) {
    // confirmed:true — o dinheiro/pix foi recebido nesse momento, diferente do
    // registro inicial em createSelfServiceOrderUsecase (confirmed:false lá,
    // que era só a intenção declarada no checkout).
    await registerPaymentUsecase({
      orderId,
      userId,
      paymentMethod: order.paymentMethod,
      confirmed: true,
    });
    await closeOrderUsecase({ orderId, userId });
  }
}

/**
 * PATCH /manager/deliveries/:id/status
 *
 * O balcão precisa poder corrigir o status: hoje uma entrega que falhou na mão
 * do entregador fica presa em `failed`, sem caminho para virar entregue — a
 * comanda nunca fecha e some dos relatórios. A máquina de estados é a MESMA do
 * entregador (`canTransitionDelivery`): o gerente tem o botão, não o poder de
 * burlar a regra, e `delivered` continua terminal.
 *
 * O que NÃO volta atrás, de propósito: `dispatchedAt`. Se o gerente reverte
 * para `awaiting_courier`, o entregador despacha de novo e `dispatch`
 * sobrescreve o campo com o momento real da nova saída. Guardar a hora antiga
 * mostraria "saiu 14:30" numa entrega que nunca saiu.
 */
export async function setDeliveryStatusUsecase(input: {
  deliveryId: string;
  status: DeliveryStatus;
  managerId: string;
  reason?: string;
}) {
  const delivery = await db.query.deliveries.findFirst({ where: eq(deliveries.id, input.deliveryId) });
  if (!delivery) throw Errors.notFound("Entrega");

  const from = delivery.status as DeliveryStatus;
  if (from === input.status) return serialize(delivery);

  if (!canTransitionDelivery(from, input.status)) {
    throw Errors.invalidDeliveryTransition(
      `Não é possível mudar a entrega de "${from}" para "${input.status}".`,
    );
  }

  const now = new Date().toISOString();
  const updated = await db.transaction(async (tx) => {
    const [result] = await tx
      .update(deliveries)
      .set({
        status: input.status,
        // `deliveredAt` só faz sentido no destino entregue; nos demais fica
        // como está, senão um cancelamento posterior exibiria "entregue em" num
        // pedido que não foi.
        deliveredAt: input.status === "delivered" ? now : delivery.deliveredAt,
        // O motivo informado pelo balcão vale o campo que o entregador usa: é
        // o mesmo texto que o cliente recebe na notificação.
        notes: input.status === "failed" ? (input.reason ?? delivery.notes) : delivery.notes,
      })
      .where(eq(deliveries.id, input.deliveryId))
      .returning();
    await enqueueEvent(tx, DELIVERY_ROOM, "delivery.status_changed", serialize(result));
    await emitCustomerStageChangedTx(tx, result.orderId);
    await logAction(tx, input.managerId, "delivery_status_changed", result.orderId, {
      from,
      to: input.status,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return result;
  });

  // Entrega concluída pelo gerente fecha a comanda igual o entregador fecha.
  if (input.status === "delivered") {
    await closeOrderAfterDelivery(updated.orderId, input.managerId);
  }

  // O gerente pode marcar `out_for_delivery` de um pedido que o entregador
  // nunca despachou (cliente ligar para avisar que já recebeu, casa fechada,
  // entregador adoentado) — e é esse pedido que mais precisa de papel na rua.
  // Reaproveita o mesmo caminho de flags de `dispatchDeliveryUsecase`.
  if (input.status === "out_for_delivery") {
    try {
      const settings = await getSettings();
      if (settings.printerEnabled && settings.printerAutoPrint) {
        printCourierOrder(updated.orderId).catch((err) =>
          console.error("falha ao imprimir comanda no courier:", err),
        );
      }
    } catch (err) {
      console.error("falha ao verificar flags de impressão:", err);
    }
  }

  return serialize(updated);
}