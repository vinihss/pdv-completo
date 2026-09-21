import React, { useState, useCallback, useEffect } from "react";
import { salesReport } from "@/shared/api/reports";
import { Section, Field, inputClass } from "@/shared/components";

export default function ReportsTab({ showToast }) {
  const [report, setReport] = useState(null);
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
          <div className="grid grid-cols-3 gap-2">
            <StatCard label="Total vendido" value={`R$ ${report.summary.totalRevenue.toFixed(2)}`} />
            <StatCard label="Comandas" value={report.summary.orderCount} />
            <StatCard label="Ticket médio" value={`R$ ${report.summary.avgTicket.toFixed(2)}`} />
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