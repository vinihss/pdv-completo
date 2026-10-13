/**
 * Total da comanda — a UMA fórmula, no domínio.
 *
 * Sempre a partir do snapshot `unit_price` do item (nunca o preço atual do
 * produto), itens "cancelled" nunca contam (mesma regra do relatório de
 * vendas), taxa de entrega soma, arredonda pra 2 casas.
 *
 * Antes desta função existiam TRÊS cópias da mesma conta (o hub de pedidos na
 * application, o compat transacional no infra e o seed de demonstração) —
 * duplicar era justamente o jeito de o fechamento, a cobrança e o seed
 * divergirem num item cancelado. Agora cada ponta só BUSCA as linhas (ports do
 * `TenantSession`, query Drizzle ou o gerador do seed) e a conta é UMA, aqui.
 */
import { round2 } from "./money.js";

/** O mínimo que a fórmula lê de cada linha: snapshot + quantidade + status. */
export interface OrderTotalLine {
  unitPrice: number;
  quantity: number;
  status: string;
}

export function computeOrderTotal(lines: OrderTotalLine[], deliveryFee: number | null): number {
  const sum = lines
    .filter((l) => l.status !== "cancelled")
    .reduce((acc, l) => acc + l.unitPrice * l.quantity, 0);
  return round2(sum + (deliveryFee ?? 0));
}
