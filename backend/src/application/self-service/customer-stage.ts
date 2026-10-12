// Emissão do stage do cliente na MESMA transação da mutação de domínio.
// O WS público (room order:<orderId>) e o polling do cliente
// (/public/orders/:id/status) consomem o evento customer.stage_changed —
// a tela de confirmação atualiza sozinha em cada mudança de etapa
// (dispatch, item pronto, entrega, cancelamento).
//
// ONDA 2: sem Drizzle/infra — a leitura do trio (comanda, itens, entrega) vem
// dos ports do `TenantSession`, e o evento entra no `session.outbox` da MESMA
// transação da escrita de domínio. O wrapper `emitCustomerStageChangedTx(tx, ...)`
// para chamadores que ainda têm um `tx` cru mora em
// `infra/composition/order-compat.ts`.
import { deriveCustomerStage, CUSTOMER_STAGES, type CustomerStage } from "../../domain/customer-order-state.js";
import type { TenantSession } from "../ports/unit-of-work.js";

// Deriva o stage atual dos 3 eixos e enfileira o evento. Chamar DENTRO da
// transação da mutação (o `TenantSession` compartilha a transação com o
// repositório), sempre com await (ver a nota de async em
// application/order/order.usecases.ts).
export async function emitCustomerStageChanged(session: TenantSession, orderId: string): Promise<CustomerStage> {
  const order = await session.orders.findRow(orderId);
  const items = await session.orders.listItemRows(orderId);
  const delivery = await session.deliveries.findByOrder(orderId);

  const stage = deriveCustomerStage(
    { status: order?.status ?? "open" },
    items.map((i) => ({ status: i.status })),
    delivery ? { status: delivery.status } : null
  );

  const meta = CUSTOMER_STAGES[stage];
  await session.outbox.enqueue({
    room: `order:${orderId}`,
    type: "customer.stage_changed",
    aggregateId: orderId,
    payload: {
      orderId,
      stage,
      label: meta.label,
      terminal: meta.terminal,
    },
  });
  return stage;
}
