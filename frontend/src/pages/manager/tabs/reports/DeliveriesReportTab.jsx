import React, { useCallback, useEffect, useState } from "react";
import { deliveriesReport, browserTzOffset, PERIOD_PRESETS, periodRange } from "@/entities/reports";
import { Section, Field, inputClass } from "@/shared/components";
import { formatBRL } from "@/shared/lib";

/**
 * Relatório de Entregas: o desempenho da operação de delivery no período.
 *
 * A receita aqui é a MESMA do relatório de pedidos (itens no snapshot + taxa),
 * de propósito: se os dois diverge, um dos dois está errado e o gerente não
 * tem como saber qual sem refazer a conta na mão.
 */
export default function DeliveriesReportTab({ showToast }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { tz: browserTzOffset() };
      if (from) params.from = from;
      if (to) params.to = to;
      setReport(await deliveriesReport(params));
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
    }
  }, [from, to, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  function pickPreset(id) {
    const r = periodRange(id);
    if (!r) return;
    setFrom(r.from);
    setTo(r.to);
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
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Até">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
        </Field>
      </div>

      {loading && <div className="text-stone-600 text-center py-10">Carregando…</div>}

      {report && !loading && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatCard label="Entregas" value={report.summary.deliveries} />
            <StatCard label="No prazo" value={`${report.summary.onTimeRate}%`} />
            <StatCard
              label="Tempo médio"
              value={report.summary.avgMinutes > 0 ? `${Math.round(report.summary.avgMinutes)} min` : "—"}
            />
            <StatCard label="Receita" value={formatBRL(report.summary.revenue)} />
          </div>

          <Section title="Situação">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
              <CountBox label="Entregues" value={report.summary.delivered} tone="text-emerald-400" />
              <CountBox label="Falhas" value={report.summary.failed} tone="text-red-400" />
              <CountBox label="Canceladas" value={report.summary.cancelled} tone="text-stone-400" />
              <CountBox label="Em aberto" value={report.summary.pending} tone="text-amber-400" />
            </div>
            <p className="text-[12px] text-stone-500">
              Taxa de entrega: {formatBRL(report.summary.deliveryFee)} em taxas ·{" "}
              {report.summary.delivered} de {report.summary.deliveries} concluídas.
            </p>
          </Section>

          <Section title={`Por entregador (${report.byCourier.length})`}>
            <div className="space-y-2">
              {report.byCourier.map((c) => (
                <div
                  key={c.id || "none"}
                  className="flex items-center justify-between text-sm bg-stone-900 border border-stone-800 rounded-xl px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{c.name}</div>
                    <div className="text-stone-500 text-xs">
                      {c.deliveries} entregas · {c.onTime} no prazo
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-semibold text-stone-100">
                      {c.avgMinutes > 0 ? `${Math.round(c.avgMinutes)} min` : "—"}
                    </div>
                    <div className="text-stone-500 text-xs">tempo médio</div>
                  </div>
                </div>
              ))}
              {report.byCourier.length === 0 && (
                <div className="text-stone-600 text-center py-6 text-sm">Nenhuma entrega no período.</div>
              )}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="bg-stone-900 border border-stone-800 rounded-xl p-3 text-center">
      <div className="text-stone-500 text-[11px] mb-1">{label}</div>
      <div className="font-display font-bold text-sm">{value}</div>
    </div>
  );
}

function CountBox({ label, value, tone }) {
  return (
    <div className="rounded-xl border border-stone-800 py-2">
      <div className={`font-display font-bold text-lg ${tone}`}>{value}</div>
      <div className="text-stone-500 text-[11px]">{label}</div>
    </div>
  );
}