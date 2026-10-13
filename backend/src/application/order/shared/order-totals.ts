/**
 * Total da comanda dentro da janela transacional do hub de pedidos.
 *
 * As LINHAS vêm dos ports do `TenantSession`; a FÓRMULA é
 * `domain/order-total.ts` — uma só, partilhada com o seed de demonstração e
 * qualquer outra ponta que calcule o total.
 */
import { computeOrderTotal } from "../../../domain/order-total.js";
import type { TenantSession } from "../../ports/unit-of-work.js";
import type { OrderRow } from "../../ports/repositories.js";

export async function computeOrderTotalInSession(session: TenantSession, order: OrderRow): Promise<number> {
  const rows = await session.orders.listItemRows(order.id);
  return computeOrderTotal(rows, order.deliveryFee);
}
