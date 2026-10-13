/**
 * Total da comanda a partir do snapshot `unit_price` (nunca o preço atual do
 * produto), arredondado pra 2 casas. Itens "cancelled" não contam (mesma regra
 * do relatório de vendas).
 *
 * A versão para um `tx` Drizzle puro (consumida por application/payment) está
 * em `infra/composition/order-compat.ts` — é a MESMA fórmula, e a cobrança do
 * gateway continua batendo com o fechamento porque os dois leem o mesmo
 * snapshot de `order_item`.
 */
import { round2 } from "../../../domain/money.js";
import type { TenantSession } from "../../ports/unit-of-work.js";
import type { OrderRow } from "../../ports/repositories.js";

export async function computeOrderTotalInSession(session: TenantSession, order: OrderRow): Promise<number> {
  const rows = await session.orders.listItemRows(order.id);
  const sum = rows
    .filter((r) => r.status !== "cancelled")
    .reduce((acc, r) => acc + r.unitPrice * r.quantity, 0);
  return round2(sum + (order.deliveryFee ?? 0));
}
