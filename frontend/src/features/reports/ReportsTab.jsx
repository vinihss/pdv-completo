import React, { useState, useCallback, useEffect } from "react";
import { salesReport } from "@/entities/reports";
import { getCashDrawerSummary } from "@/entities/cash";
import { Section, Field, inputClass } from "@/shared/components";
import { toDate } from "@/shared/lib";
import { buildCashReportView, browserTzOffset, fmtMoney } from "./cashReportView.js";

export default function ReportsTab({ showToast }) {
  const [report, setReport] = useState(null);
  const [cash, setCash] = useState(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (dateFrom) params.dateFrom = dateFrom;
      if (dateTo) params.dateTo = dateTo;
      if (customerQuery) params.customerQuery = customerQuery;
      setReport(await salesReport(params));

      const cashParams = { tz: browserTzOffset() };
      if (dateFrom) cashParams.from = dateFrom;
      if (dateTo) cashParams.to = dateTo;
      setCash(await getCashDrawerSummary(cashParams));
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, customerQuery]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-5 max-w-2xl mx-auto space-y-5">
      <div className="grid grid-cols-2 gap-2">
        <Field label="De"><input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputClass} /></Field>
        <Field label="Até"><input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputClass} /></Field>
      </div>
      <Field label="Cliente / mesa">
        <input value={customerQuery} onChange={(e) => setCustomerQuery(e.target.value)} placeholder="Buscar..." className={inputClass} />
      </Field>

      {loading && <div className="text-stone-600 text-center py-10">Carregando…</div>}

      {report && !loading && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatCard label="Total vendido" value={`R$ ${report.summary.totalRevenue.toFixed(2)}`} />
            <StatCard label="Comandas" value={report.summary.orderCount} />
            <StatCard label="Ticket médio" value={`R$ ${report.summary.avgTicket.toFixed(2)}`} />
            <StatCard label="Troco (dinheiro)" value={`R$ ${report.summary.changeTotal.toFixed(2)}`} />
          </div>
          <Section title="Por forma de pagamento">
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(report.summary.byPaymentMethod).map(([m, v]) => (
                <div key={m} className="flex items-center justify-between text-sm">
                  <span className="text-stone-400 capitalize">{{ cash: "Dinheiro", card: "Cartão", pix: "Pix", other: "Outro" }[m]}</span>
                  <span className="font-semibold">R$ {v.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </Section>
          <Section title="Por produto">
            <div className="space-y-1.5">
              {(report.summary.byProduct ?? []).map((p) => {
                const margin = p.revenue > 0 ? (p.profit / p.revenue) * 100 : 0;
                return (
                  <div key={p.productId} className="flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{p.name}</div>
                      <div className="text-stone-500 text-xs">{p.quantity}x vendidos</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-semibold text-emerald-400">R$ {p.revenue.toFixed(2)}</div>
                      {p.cost > 0 ? (
                        <div className="text-stone-500 text-xs">
                          custo R$ {p.cost.toFixed(2)} · lucro R$ {p.profit.toFixed(2)} · margem {margin.toFixed(0)}%
                        </div>
                      ) : (
                        <div className="text-stone-600 text-xs">sem custo cadastrado</div>
                      )}
                    </div>
                  </div>
                );
              })}
              {(report.summary.byProduct ?? []).length === 0 && (
                <div className="text-stone-600 text-center py-4 text-sm">Nenhuma venda de produto no período.</div>
              )}
            </div>
          </Section>
          <Section title={`Comandas fechadas (${report.total})`}>
            <div className="space-y-2">
              {report.data.map((o) => (
                <div key={o.orderId} className="flex items-center justify-between text-sm">
                  <div>
                    <div className="font-medium">{o.label}</div>
                    <div className="text-stone-500 text-xs">{o.closedAt} · {o.paymentMethod}</div>
                  </div>
                  <span className="text-emerald-400 font-semibold">R$ {o.total.toFixed(2)}</span>
                </div>
              ))}
              {report.data.length === 0 && <div className="text-stone-600 text-center py-6 text-sm">Nenhuma comanda no período.</div>}
            </div>
          </Section>
          {cash && (
            <Section title={`Fluxo de caixa (${cash.sessions.length})`}>
              {(() => {
                const view = buildCashReportView(cash);
                return (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                      <StatCard label="Fundo" value={fmtMoney(view.totalOpening)} />
                      <StatCard label="Vendas $" value={fmtMoney(view.totalSales)} />
                      <StatCard label="Esperado" value={fmtMoney(view.totalExpected)} />
                      <StatCard
                        label="Diferença"
                        value={`${view.totalDifference > 0 ? "+" : ""}${fmtMoney(view.totalDifference)}`}
                      />
                    </div>
                    {view.openCount > 0 && (
                      <div className="text-stone-500 text-xs mb-3">
                        <b className="text-amber-400">{view.openCount} sessão(ões) em aberto</b> no período —
                        {fmtMoney(view.openExpected)} ainda não contado.
                      </div>
                    )}
                    <div className="space-y-2">
                      {view.sessions.map((s) => (
                        <div key={s.id} className="flex items-center justify-between text-sm bg-stone-900 border border-stone-800 rounded-xl px-3 py-2">
                          <div>
                            <div className="font-medium">Aberto {toDate(s.openedAt).toLocaleString()}</div>
                            <div className="text-stone-500 text-xs">
                              {s.isOpen
                                ? "ainda aberto"
                                : `fechado ${s.closedAt && toDate(s.closedAt).toLocaleString()}`}
                              {s.openedByName ? ` · ${s.openedByName}` : ""}
                            </div>
                          </div>
                          {s.isOpen ? (
                            <div className="text-right">
                              <div className="font-semibold text-amber-400">em aberto</div>
                              <div className="text-stone-500 text-xs">esperado {fmtMoney(s.expected)}</div>
                            </div>
                          ) : (
                            <div className="text-right">
                              <div className={`font-semibold ${s.diff > 0 ? "text-emerald-400" : s.diff < 0 ? "text-red-400" : "text-stone-200"}`}>
                                {s.diff > 0 ? "+" : ""}{fmtMoney(s.diff)}
                              </div>
                              <div className="text-stone-500 text-xs">esperado {fmtMoney(s.expected ?? 0)}</div>
                            </div>
                          )}
                        </div>
                      ))}
                      {view.sessions.length === 0 && <div className="text-stone-600 text-center py-6 text-sm">Nenhum caixa no período.</div>}
                    </div>
                  </>
                );
              })()}
            </Section>
          )}
        </>
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