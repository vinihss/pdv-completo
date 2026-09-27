// Emissão do stage do cliente na MESMA transação da mutação de domínio.
// O WS público (room order:<orderId>) e o polling do cliente
// (/public/orders/:id/status) consomem o evento customer.stage_changed —
// a tela de confirmação atualiza sozinha em cada mudança de etapa
// (dispatch, item pronto, entrega, cancelamento).
import { eq } from "drizzle-orm";
import { orders, orderItems, deliveries } from "../../infra/db/schema.js";
import { deriveCustomerStage, CUSTOMER_STAGES, type CustomerStage } from "../../domain/customer-order-state.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";
import type { Tx } from "../../infra/db/client.js";

// Deriva o stage atual dos 3 eixos e enfileira o evento. Chamar DENTRO do
// db.transaction da mutação, sempre com await (ver a nota de async em
// application/order/order.usecases.ts).
export async function emitCustomerStageChangedTx(tx: Tx, orderId: string): Promise<CustomerStage> {
  const order = await tx.query.orders.findFirst({ where: eq(orders.id, orderId) });
  const items = await tx.query.orderItems.findMany({ where: eq(orderItems.orderId, orderId) });
  const delivery = (await tx.query.deliveries.findFirst({ where: eq(deliveries.orderId, orderId) })) ?? null;

  const stage = deriveCustomerStage(
    { status: order?.status ?? "open" },
    items.map((i) => ({ status: i.status })),
    delivery ? { status: delivery.status } : null
  );

  const meta = CUSTOMER_STAGES[stage];
  await enqueueEvent(tx, `order:${orderId}`, "customer.stage_changed", {
    orderId,
    stage,
    label: meta.label,
    terminal: meta.terminal,
  });
  return stage;
}
