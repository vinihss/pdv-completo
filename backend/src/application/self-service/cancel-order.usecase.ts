// Cancelamento pelo cliente — ONDA 3 da refatoração arquitetural.
//
// Este arquivo é uma FACTORY pura (`createSelfServiceCancelUsecases(deps)`):
// nenhuma importação de infra/integrations/config nem Drizzle. As leituras de
// autorização/estado passam pelo `uow.run`/`session.*`, e o cancelamento real
// (estorno de estoque/caixa, eventos outbox, propagação pra delivery) chega
// injetado pela composition root (`cancelOrder`).
//
// Cancelamento pelo cliente — dor real de quem pediu errado pela página
// (§04: continuação/correção do ciclo sem intervenção manual). Segurança: o
// endpoint é público, então o body traz o telefone — só o dono do pedido
// (customer.phone match) cancela; o UUID do pedido sozinho não autoriza.
// Restrição de estágio: CUSTOMER_CANCELLABLE_STAGES (customer-order-state.ts)
// — só antes do entregador sair em rota, ou quando a entrega já falhou e o
// pedido continua aberto.
//
// Reusa `cancelOrderUsecase` (estorno de estoque/caixa, eventos outbox,
// propagação pra delivery na mesma transação) — mesmo padrão de composição
// do createSelfServiceOrderUsecase.
//
// APROXIMAÇÃO DE JANELA (mesma da Onda 2): as leituras que hoje rodam "fora do
// tx" (cliente, pedido, itens, entrega) entram num único `uow.run`. O
// `cancelOrder` roda DEPOIS, com a própria transação — a mesma sequência de
// antes (leitura → escrita), sem meio-commit.
import { Errors } from "../../domain/errors.js";
import { SYSTEM_USER_ID } from "../../domain/constants.js";
import { deriveCustomerStage, isCustomerCancellable } from "../../domain/customer-order-state.js";
import type { TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";

export interface SelfServiceCancelUsecasesDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  /**
   * Cancelamento real do hub de pedidos (mesma `cancelOrderUsecase`), injetado
   * pela composition root — a application não importa infra. O retorno é o
   * `{ id, status }` da comanda cancelada.
   */
  cancelOrder: (input: { orderId: string; userId: string; reason: string }) => Promise<{ id: string; status: string }>;
}

export function createSelfServiceCancelUsecases(deps: SelfServiceCancelUsecasesDeps) {
  return {
    async cancelSelfServiceOrderUsecase(input: { orderId: string; customerPhone: string }) {
      const digitsPhone = input.customerPhone.replace(/\D/g, "");
      if (!digitsPhone) throw Errors.validationFailed({ field: "customerPhone", reason: "informe seu telefone" });

      const { orderId, cancellable } = await deps.uow.run(deps.tenant(), async (session) => {
        const customer = await session.customers.findByPhone(digitsPhone);
        // Telefone não confere com o dono → não revela existência do pedido
        // (mesma resposta para pedido inexistente e pedido alheio).
        const order = await session.orders.findRow(input.orderId);
        if (!order || !customer || order.customerId !== customer.id) throw Errors.forbiddenRole();

        if (order.channel !== "web" && order.channel !== "whatsapp") throw Errors.forbiddenRole();

        // Stage atual via máquina central — cancelável antes do entregador sair
        // em rota, ou quando a entrega falhou e o pedido continua aberto.
        const items = await session.orders.listItemRows(order.id);
        const delivery = await session.deliveries.findByOrder(order.id);
        const stage = deriveCustomerStage(
          { status: order.status },
          items.map((i) => ({ status: i.status })),
          delivery ? { status: delivery.status } : null
        );
        return { orderId: order.id, cancellable: isCustomerCancellable(stage) };
      });

      if (!cancellable) {
        throw Errors.invalidDeliveryTransition(
          "Seu pedido já saiu para entrega — não é possível cancelar por aqui. Fale com o estabelecimento."
        );
      }

      const cancelled = await deps.cancelOrder({
        orderId,
        userId: SYSTEM_USER_ID,
        reason: "Cancelado pelo cliente",
      });

      return { orderId: cancelled.id, status: cancelled.status };
    },
  };
}

export type SelfServiceCancelUsecases = ReturnType<typeof createSelfServiceCancelUsecases>;
