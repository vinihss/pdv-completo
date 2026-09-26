// Cancelamento pelo cliente — dor real de quem pediu errado pela página
// ou pelo WhatsApp (§04: continuação/correção do ciclo sem intervenção
// manual). Segurança: o endpoint é público, então o body traz o telefone —
// só o dono do pedido (customer.phone match) cancela; o UUID do pedido
// sozinho não autoriza. Restrição de estágio: CUSTOMER_CANCELLABLE_STAGES
// (customer-order-state.ts) — só antes do entregador sair em rota, ou
// quando a entrega já falhou e o pedido continua aberto.
//
// Reusa cancelOrderUsecase (estorno de estoque/caixa, eventos outbox,
// propagação pra delivery na mesma transação) — mesmo padrão de composição
// do createSelfServiceOrderUsecase. Cancelamento manager-driven notifica
// pelo mesmo caminho (ver order.usecases.ts#cancelOrderUsecase → não; a
// notificação do manager é responsabilidade do painel).
import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { orders, orderItems, deliveries, customers } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { SYSTEM_USER_ID } from "../../domain/constants.js";
import { cancelOrderUsecase } from "../order/order.usecases.js";
import { deriveCustomerStage, isCustomerCancellable } from "../../domain/customer-order-state.js";
import { notifyCancelled } from "../../integrations/whatsapp/whatsapp.notifier.js";

export async function cancelSelfServiceOrderUsecase(input: { orderId: string; customerPhone: string }) {
  const digitsPhone = input.customerPhone.replace(/\D/g, "");
  if (!digitsPhone) throw Errors.validationFailed({ field: "customerPhone", reason: "informe seu telefone" });

  const customer = await db.query.customers.findFirst({ where: eq(customers.phone, digitsPhone) });
  // Telefone não confere com o dono → não revela existência do pedido (mesma
  // resposta para pedido inexistente e pedido alheio).
  const order = await db.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
  if (!order || !customer || order.customerId !== customer.id) throw Errors.forbiddenRole();

  if (order.channel !== "whatsapp" && order.channel !== "web") throw Errors.forbiddenRole();

  // Stage atual via máquina central — cancelável antes do entregador sair
  // em rota, ou quando a entrega falhou e o pedido continua aberto.
  const items = await db.query.orderItems.findMany({ where: eq(orderItems.orderId, order.id) });
  const delivery = await db.query.deliveries.findFirst({ where: eq(deliveries.orderId, order.id) });
  const stage = deriveCustomerStage(
    { status: order.status },
    items.map((i) => ({ status: i.status })),
    delivery ? { status: delivery.status } : null
  );
  if (!isCustomerCancellable(stage)) {
    throw Errors.invalidDeliveryTransition(
      "Seu pedido já saiu para entrega — não é possível cancelar por aqui. Fale com o estabelecimento."
    );
  }

  const cancelled = await cancelOrderUsecase({
    orderId: order.id,
    userId: SYSTEM_USER_ID,
    reason: "Cancelado pelo cliente",
  });

  notifyCancelled(order.id, "cancelado pelo cliente").catch((err) =>
    console.error("falha ao notificar cancelamento pro cliente:", err)
  );

  return { orderId: cancelled.id, status: cancelled.status };
}
