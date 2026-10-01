import React, { useCallback, useEffect, useState } from "react";
import { salesReport, PERIOD_PRESETS, periodRange } from "@/entities/reports";
import { Section, Field, inputClass } from "@/shared/components";
import { formatBRL } from "@/shared/lib";

/**
 * Relatório de Pedidos: comandas fechadas no período, com o que vendeu,
 * por forma de pagamento e por produto.
 *
 * Extraído de `ReportsTab.jsx`, que antes mostrava isto, o caixa e os totais
 * na mesma rolagem — três relatórios num scroll só, em que o gerente
 * encontrava o número do caixa rolando os pedidos.
 */
export default function OrdersReportTab({ showToast }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (dateFrom) params.dateFrom = dateFrom;
      if (dateTo) params.dateTo = dateTo;
      if (customerQuery) params.customerQuery = customerQuery;
      setReport(await salesReport(params));
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, customerQuery, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  function pickPreset(id) {
    const r = periodRange(id);
    if (!r) return;
    setDateFrom(r.from);
    setDateTo(r.to);
  }

  return (
    <div className="p-5 max-w-2xl mx-auto space-y-5">
      <div className="flex flex-wrap gap-1.5">
        {PERIOD_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => pickPreset(p.id)}
            className="px-3 h-8 rounded-lg text-[13px] font-medium bg-stone-900 border border-stone-800 text-stone-400 hover:text-stone-100 transition-colors"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="De">
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Até">
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputClass} />
        </Field>
      </div>
      <Field label="Cliente / mesa">
        <input
          value={customerQuery}
          onChange={(e) => setCustomerQuery(e.target.value)}
          placeholder="Buscar..."
          className={inputClass}
        />
      </Field>

      {loading && <div className="text-stone-600 text-center py-10">Carregando…</div>}

      {report && !loading && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatCard label="Total vendido" value={formatBRL(report.summary.totalRevenue)} />
            <StatCard label="Comandas" value={report.summary.orderCount} />
            <StatCard label="Ticket médio" value={formatBRL(report.summary.avgTicket)} />
            <StatCard label="Troco (dinheiro)" value={formatBRL(report.summary.changeTotal)} />
          </div>

          <Section title="Por forma de pagamento">
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(report.summary.byPaymentMethod).map(([m, v]) => (
                <div key={m} className="flex items-center justify-between text-sm">
                  <span className="text-stone-400 capitalize">
                    {{ cash: "Dinheiro", card: "Cartão", pix: "Pix", other: "Outro" }[m]}
                  </span>
                  <span className="font-semibold">{formatBRL(v)}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Por produto">
            <ProductBreakdown products={report.summary.byProduct ?? []} />
          </Section>

          <Section title={`Comandas fechadas (${report.total})`}>
            <div className="space-y-2">
              {report.data.map((o) => (
                <div key={o.orderId} className="flex items-center justify-between text-sm">
                  <div>
                    <div className="font-medium">{o.label}</div>
                    <div className="text-stone-500 text-xs">
                      {o.closedAt} · {o.paymentMethod}
                    </div>
                  </div>
                  <span className="text-emerald-400 font-semibold">{formatBRL(o.total)}</span>
                </div>
              ))}
              {report.data.length === 0 && (
                <div className="text-stone-600 text-center py-6 text-sm">Nenhuma comanda no período.</div>
              )}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function ProductBreakdown({ products }) {
  return (
    <div className="space-y-1.5">
      {products.map((p) => {
        const margin = p.revenue > 0 ? (p.profit / p.revenue) * 100 : 0;
        return (
          <div key={p.productId} className="flex items-center justify-between gap-3 text-sm">
            <div className="min-w-0">
              <div className="font-medium truncate">{p.name}</div>
              <div className="text-stone-500 text-xs">{p.quantity}x vendidos</div>
            </div>
            <div className="text-right shrink-0">
              <div className="font-semibold text-emerald-400">{formatBRL(p.revenue)}</div>
              {p.cost > 0 ? (
                <div className="text-stone-500 text-xs">
                  custo {formatBRL(p.cost)} · lucro {formatBRL(p.profit)} · margem {margin.toFixed(0)}%
                </div>
              ) : (
                <div className="text-stone-600 text-xs">sem custo cadastrado</div>
              )}
            </div>
          </div>
        );
      })}
      {products.length === 0 && (
        <div className="text-stone-600 text-center py-4 text-sm">Nenhuma venda de produto no período.</div>
      )}
    </div>
  );
}

export function StatCard({ label, value }) {
  return (
    <div className="bg-stone-900 border border-stone-800 rounded-xl p-3 text-center">
      <div className="text-stone-500 text-[11px] mb-1">{label}</div>
      <div className="font-display font-bold text-sm">{value}</div>
    </div>
  );
}