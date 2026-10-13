/**
 * `GET /reports/sales` — relatório de vendas.
 *
 * Toda leitura roda na janela `uow.run` via `session.reports` (mesmas queries,
 * mesmos JOINs/filtros/janela de 30 dias — o adapter replica 1:1 os módulos
 * legados). O cache `reports:sales:*` é efeito via port `TenantCache`
 * (get/set, TTL 300), com `set` DEPOIS do commit.
 *
 * Semântica preservada linha a linha:
 *   - filtro `customerQuery` em JS sobre as linhas já buscadas (mesa/cliente/
 *     tabLabel em lowercase);
 *   - filtro `productId` via order_ids que contêm o produto (SELECT DISTINCT);
 *   - totais por comanda e por produto agregados em JS sobre o snapshot
 *     (`unit_price × quantity`, sem cancelados); margem = revenue - cost;
 *   - estornos `settled` (Bloco 4) — bruto/líquido expostos no summary;
 *   - pagamento fracionado por `order_payment` com fallback no denormalizado
 *     `orders.payment_method` para histórico pré-feature;
 *   - summary agregado sobre TODO o conjunto filtrado (não a página), página
 *     ordenada por `closedAt DESC`.
 */
import { round2 } from "../../../domain/money.js";
import type { ReportDependencies } from "../ports/report-dependencies.js";

// Cache particionado por schema: relatórios são sempre do tenant corrente
// (o port TenantCache injetado já é o proxy com prefixo por schema).
function reportKey(input: { dateFrom?: string; dateTo?: string; customerQuery?: string; productId?: string }): string {
  return `reports:sales:${JSON.stringify(input)}`;
}

export type SalesReportInput = {
  dateFrom?: string;
  dateTo?: string;
  customerQuery?: string;
  productId?: string;
  limit: number;
  offset: number;
};

export class SalesReportUseCase {
  constructor(private readonly deps: ReportDependencies) {}

  async execute(input: SalesReportInput) {
    const key = reportKey(input);
    const cached = await this.deps.cache.get<{ data: unknown[]; total: number; summary: unknown }>(key);
    if (cached) return cached;

    const result = await this.deps.uow.run(this.deps.tenant(), async (session) => {
      // Busca base: comandas fechadas dentro do período (janela default de
      // 30 dias quando sem `dateFrom`/`dateTo` — mesma régua do original,
      // aplicada no adapter junto dos filtros de data).
      let orderRows = await session.reports.listClosedOrders({ dateFrom: input.dateFrom, dateTo: input.dateTo });

      if (input.customerQuery) {
        const q = input.customerQuery.toLowerCase();
        orderRows = orderRows.filter(
          (o) =>
            (o.tableNumber ?? "").toLowerCase().includes(q) ||
            (o.customerName ?? "").toLowerCase().includes(q) ||
            (o.tabLabel ?? "").toLowerCase().includes(q)
        );
      }

      if (input.productId) {
        const idsWithProduct = new Set(await session.reports.listOrderIdsByProduct(input.productId));
        orderRows = orderRows.filter((o) => idsWithProduct.has(o.id));
      }

      // Grandes totais por comanda + totais por produto, ambos sobre TODO o
      // conjunto filtrado (não a página). Margem por produto: revenue usa o
      // snapshot unit_price; custo usa o snapshot order_item.cost_price (0 em
      // itens lançados antes da feature de estoque — margem só é confiável
      // quando há custo cadastrado).
      //
      // Estornos (Bloco 4 ROADMAP-CAIXA.md): venda estornada vira linha negativa
      // no relatório, não desaparece. O faturamento líquido = bruto - estornos
      // settled. O relatório expõe ambos (bruto e líquido) para transparência.
      const totalsByOrder = new Map<string, number>();
      const prodTotals = new Map<string, { qty: number; revenue: number; cost: number }>();
      const orderIds = orderRows.map((o) => o.id);

      if (orderRows.length > 0) {
        const itemRows = await session.reports.listOrderItems(orderIds);

        for (const it of itemRows) {
          if (it.status === "cancelled") continue;
          totalsByOrder.set(it.orderId, (totalsByOrder.get(it.orderId) ?? 0) + it.unitPrice * it.quantity);
          const cur = prodTotals.get(it.productId) ?? { qty: 0, revenue: 0, cost: 0 };
          cur.qty += it.quantity;
          cur.revenue += it.unitPrice * it.quantity;
          cur.cost += (it.costPrice ?? 0) * it.quantity;
          prodTotals.set(it.productId, cur);
        }
      }

      // Estornos settled por pedido (Bloco 4): soma dos refunds com status='settled'
      const refundsByOrder = new Map<string, number>();
      if (orderIds.length > 0) {
        const refundRows = await session.reports.listSettledRefunds(orderIds);

        for (const r of refundRows) {
          refundsByOrder.set(r.orderId, (refundsByOrder.get(r.orderId) ?? 0) + r.amount);
        }
      }

      const productIds = [...prodTotals.keys()];
      const productRows = await session.reports.listProductNames(productIds);
      const nameMap = new Map(productRows.map((p) => [p.id, p.name]));
      const byProduct = [...prodTotals.entries()]
        .map(([productId, t]) => {
          const revenue = round2(t.revenue);
          const cost = round2(t.cost);
          return {
            productId,
            name: nameMap.get(productId) ?? "—",
            quantity: t.qty,
            revenue,
            cost,
            profit: round2(revenue - cost),
          };
        })
        .sort((a, b) => b.revenue - a.revenue);

      // Pagamento fracionado: o detalhamento por forma vem das linhas de
      // order_payment (cada método com seu valor). Comandas antigas (pré-order_payment)
      // caem no denormalizado orders.payment_method pra não sumir do relatório.
      const paymentRows = await session.reports.listOrderPayments(orderIds);

      const paidByOrder = new Map<string, number>();
      const methodsByOrder = new Map<string, string[]>();
      const byPaymentMethod: Record<string, number> = { cash: 0, card: 0, pix: 0, other: 0 };
      let changeTotal = 0;

      for (const p of paymentRows) {
        paidByOrder.set(p.orderId, (paidByOrder.get(p.orderId) ?? 0) + p.amount);
        if (p.method) {
          const byId = methodsByOrder.get(p.orderId) ?? [];
          if (!byId.includes(p.method)) methodsByOrder.set(p.orderId, [...byId, p.method]);
          byPaymentMethod[p.method] = (byPaymentMethod[p.method] ?? 0) + p.amount;
        }
        if (p.change) changeTotal += p.change;
      }

      // Comandas sem splits (registro antigo) atribuem o total ao payment_method
      // denormalizado — mantém o relatório correto em histórico pré-feature.
      for (const o of orderRows) {
        const total = (totalsByOrder.get(o.id) ?? 0) + (o.deliveryFee ?? 0);
        const paid = round2(paidByOrder.get(o.id) ?? 0);
        const remainder = round2(total - paid);
        if (remainder > 0.004) {
          const m: string = o.paymentMethod ?? "other";
          byPaymentMethod[m] = (byPaymentMethod[m] ?? 0) + remainder;
          const byId = methodsByOrder.get(o.id) ?? [];
          if (!byId.includes(m)) methodsByOrder.set(o.id, [...byId, m]);
        }
      }

      for (const key of Object.keys(byPaymentMethod)) {
        byPaymentMethod[key] = round2(byPaymentMethod[key]);
      }
      const changeTotalRound = round2(changeTotal);

      const enriched = orderRows.map((o) => {
        const grossTotal = (totalsByOrder.get(o.id) ?? 0) + (o.deliveryFee ?? 0);
        const refundsTotal = round2(refundsByOrder.get(o.id) ?? 0);
        const netTotal = round2(grossTotal - refundsTotal);

        return {
          orderId: o.id,
          label: o.tableNumber ? `Mesa ${o.tableNumber}` : o.customerName ?? o.tabLabel ?? "—",
          closedAt: o.closedAt,
          paymentMethod: methodsByOrder.get(o.id)?.join(" + ") ?? o.paymentMethod ?? "—",
          grossTotal,
          refundsTotal,
          netTotal,
        };
      });

      // summary é agregado sobre TODO o conjunto filtrado, não sobre a página (§7.9)
      // Bloco 4: expõe bruto, estornos e líquido para transparência
      const totalRevenue = round2(enriched.reduce((sum, o) => sum + o.grossTotal, 0));
      const totalRefunds = round2(enriched.reduce((sum, o) => sum + o.refundsTotal, 0));
      const totalNet = round2(enriched.reduce((sum, o) => sum + o.netTotal, 0));
      const orderCount = enriched.length;
      const avgTicket = orderCount > 0 ? round2(totalNet / orderCount) : 0;

      const page = enriched
        .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
        .slice(input.offset, input.offset + input.limit);

      return {
        data: page,
        total: orderCount,
        summary: {
          grossRevenue: totalRevenue,
          totalRefunds,
          // totalNet é a soma dos netTotal; netRevenue é alias para compatibilidade
          netRevenue: totalNet,
          totalNet,
          orderCount,
          avgTicket,
          byPaymentMethod,
          byProduct,
          changeTotal: changeTotalRound,
        },
      };
    });

    await this.deps.cache.set(key, result, { ttl: 300 });
    return result;
  }
}
