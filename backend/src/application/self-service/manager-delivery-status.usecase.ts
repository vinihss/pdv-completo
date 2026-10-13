// Edição de status de entrega pelo GERENTE — ONDA 3 da refatoração arquitetural.
//
// Este arquivo é uma FACTORY pura (`createManagerDeliveryStatusUsecases(deps)`)
// + a factory do efeito compartilhado `createCloseOrderAfterDelivery(deps)`:
// nenhuma importação de infra/integrations/config nem Drizzle. A persistência
// passa pelo `uow.run`/`session.*` e o fechamento da comanda reusa as use cases
// do hub de pedidos (`registerPayment`/`closeOrder`) INJETADAS pela composition
// root — a application não importa infra.
//
// Existe separada do `delivery.usecases.ts` (mesmo domínio, mesma
// `DELIVERY_ROOM`) por um motivo concreto: o pedaço compartilhado com o
// `deliverDeliveryUsecase` — marcar itens como entregues e fechar a comanda —
// precisa morar num lugar que os dois importem sem criar ciclo. Aqui ele é a
// factory `createCloseOrderAfterDelivery`, composta UMA vez pela composition
// root e injetada nos dois (o `delivery.usecases.ts` a recebe por parâmetro).
//
// APROXIMAÇÃO DE JANELA (mesma da Onda 2): as leituras que antes rodavam "fora
// do tx" (entrega, settings) entram no mesmo `uow.run` da escrita. O
// `closeOrderAfterDelivery` marca os itens e lê a comanda numa janela, e chama
// `registerPayment`/`closeOrder` DEPOIS, cada um com sua própria transação —
// a mesma composição sequencial de antes (passos atômicos um a um, não uma
// transação única).
import { Errors } from "../../domain/errors.js";
import { canTransitionDelivery, type DeliveryStatus } from "../../domain/customer-order-state.js";
import { emitCustomerStageChanged } from "./customer-stage.js";
import type { OrderUsecases } from "../order/order.usecases.js";
import type { TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";
import type { DeliveryRecord, PaymentMethodKind } from "../ports/repositories.js";
import type { OrderPrinter, StoreSettingsReader } from "../ports/effects.js";

const DELIVERY_ROOM = "deliveries";

function serialize(d: DeliveryRecord) {
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
 * Deps: Unit-of-Worker + tenant + `registerPayment`/`closeOrder` do hub de
 * pedidos (injetados). A composition root cria UMA instância e injeta o
 * retorno nos dois use cases que concluem entrega (`deliverDeliveryUsecase` e
 * `setDeliveryStatusUsecase`), evitando duas cópias divergindo.
 */
export interface CloseOrderAfterDeliveryDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  /** `registerPaymentUsecase` do hub de pedidos (já ligado às deps dele). */
  registerPayment: OrderUsecases["registerPaymentUsecase"];
  /** `closeOrderUsecase` do hub de pedidos (já ligado às deps dele). */
  closeOrder: OrderUsecases["closeOrderUsecase"];
}

export function createCloseOrderAfterDelivery(deps: CloseOrderAfterDeliveryDeps) {
  return async function closeOrderAfterDelivery(orderId: string, userId: string): Promise<void> {
    const order = await deps.uow.run(deps.tenant(), async (session) => {
      await session.orders.markItemsDelivered(orderId);
      return session.orders.findRow(orderId);
    });

    if (order?.paymentMethod) {
      // confirmed:true — o dinheiro/pix foi recebido nesse momento, diferente do
      // registro inicial em createSelfServiceOrderUsecase (confirmed:false lá,
      // que era só a intenção declarada no checkout). `paymentMethod` é o
      // denormalizado de exibição (coluna `text`): o valor veio de uma linha de
      // `order_payment`, que só grava as quatro formas válidas do checkout.
      await deps.registerPayment({
        orderId,
        userId,
        paymentMethod: order.paymentMethod as PaymentMethodKind,
        confirmed: true,
      });
      await deps.closeOrder({ orderId, userId });
    }
  };
}

export type CloseOrderAfterDelivery = ReturnType<typeof createCloseOrderAfterDelivery>;

// ---------- factory ----------

export interface ManagerDeliveryStatusUsecasesDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  settings: StoreSettingsReader;
  printer: OrderPrinter;
  /** Efeito compartilhado com `deliverDeliveryUsecase` (ver acima). */
  closeOrderAfterDelivery: CloseOrderAfterDelivery;
}

/**
 * `PATCH /manager/deliveries/:id/status` sobre o Unit-of-Worker. Os nomes
 * legados (`setDeliveryStatusUsecase(...)`) são re-exportados por
 * `infra/composition/default-usecases.ts`.
 */
export function createManagerDeliveryStatusUsecases(deps: ManagerDeliveryStatusUsecasesDeps) {
  return {
    /**
     * PATCH /manager/deliveries/:id/status
     *
     * O balcão precisa poder corrigir o status: hoje uma entrega que falhou na
     * mão do entregador fica presa em `failed`, sem caminho para virar
     * entregue — a comanda nunca fecha e some dos relatórios. A máquina de
     * estados é a MESMA do entregador (`canTransitionDelivery`): o gerente tem
     * o botão, não o poder de burlar a regra, e `delivered` continua terminal.
     *
     * O que NÃO volta atrás, de propósito: `dispatchedAt`. Se o gerente
     * reverte para `awaiting_courier`, o entregador despacha de novo e
     * `dispatch` sobrescreve o campo com o momento real da nova saída. Guardar
     * a hora antiga mostraria "saiu 14:30" numa entrega que nunca saiu.
     */
    async setDeliveryStatusUsecase(input: {
      deliveryId: string;
      status: DeliveryStatus;
      managerId: string;
      reason?: string;
    }) {
      const result = await deps.uow.run(deps.tenant(), async (session) => {
        const delivery = await session.deliveries.findById(input.deliveryId);
        if (!delivery) throw Errors.notFound("Entrega");

        const from = delivery.status as DeliveryStatus;
        // Sem mudança de status: devolve como está, sem evento/audit (mesma
        // régua do original).
        if (from === input.status) return { unchanged: delivery, updated: null as DeliveryRecord | null, from };

        if (!canTransitionDelivery(from, input.status)) {
          throw Errors.invalidDeliveryTransition(
            `Não é possível mudar a entrega de "${from}" para "${input.status}".`,
          );
        }

        const now = new Date().toISOString();
        const updated = await session.deliveries.setStatus(input.deliveryId, {
          status: input.status,
          // `deliveredAt` só faz sentido no destino entregue; nos demais fica
          // como está, senão um cancelamento posterior exibiria "entregue em"
          // num pedido que não foi.
          deliveredAt: input.status === "delivered" ? now : delivery.deliveredAt,
          // O motivo informado pelo balcão vale o campo que o entregador usa:
          // é o mesmo texto que o cliente recebe na notificação.
          notes: input.status === "failed" ? (input.reason ?? delivery.notes) : delivery.notes,
        });

        await session.outbox.enqueue({
          room: DELIVERY_ROOM,
          type: "delivery.status_changed",
          aggregateId: updated.id,
          payload: serialize(updated),
        });
        await emitCustomerStageChanged(session, updated.orderId);
        await session.audit.record({
          actorId: input.managerId,
          action: "delivery_status_changed",
          orderId: updated.orderId,
          details: {
            from,
            to: input.status,
            ...(input.reason ? { reason: input.reason } : {}),
          },
        });
        return { unchanged: null as DeliveryRecord | null, updated, from };
      });

      if (result.unchanged) return serialize(result.unchanged);
      const updated = result.updated!;

      // Entrega concluída pelo gerente fecha a comanda igual o entregador fecha.
      if (input.status === "delivered") {
        await deps.closeOrderAfterDelivery(updated.orderId, input.managerId);
      }

      // O gerente pode marcar `out_for_delivery` de um pedido que o entregador
      // nunca despachou (cliente ligar para avisar que já recebeu, casa fechada,
      // entregador adoentado) — e é esse pedido que mais precisa de papel na rua.
      // Reaproveita o mesmo caminho de flags de `dispatchDeliveryUsecase`.
      if (input.status === "out_for_delivery") {
        try {
          const settings = await deps.settings.get();
          if (settings.printerEnabled && settings.printerAutoPrint) {
            deps.printer
              .printCourierOrder(updated.orderId)
              .catch((err) => console.error("falha ao imprimir comanda no courier:", err));
          }
        } catch (err) {
          console.error("falha ao verificar flags de impressão:", err);
        }
      }

      return serialize(updated);
    },
  };
}

export type ManagerDeliveryStatusUsecases = ReturnType<typeof createManagerDeliveryStatusUsecases>;
