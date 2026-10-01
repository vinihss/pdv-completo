import React, { useCallback, useEffect, useState } from "react";
import { getCashDrawerSummary } from "@/entities/cash";
import { buildCashReportView, browserTzOffset, fmtMoney, PERIOD_PRESETS, periodRange } from "@/entities/reports";
import { Section, Field, inputClass } from "@/shared/components";
import { toDate } from "@/shared/lib";

/**
 * Relatório de Fluxo de caixa: quanto entrou em cada gaveta, quanto foi
 * esperado, quanto foi contado e a diferença.
 *
 * Separado do relatório de Pedidos porque as duas perguntas não são a mesma:
 * o pedido diz quanto a loja VENCEU, o caixa diz quanto o dinheiro batendo na
 * gaveta confere com o que deveria. Uma diferença de R$ 300 aparece em um e
 * não no outro, e essa diferença é a que o gerente precisa ver.
 */
export default function CashFlowReportTab({ showToast }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cash, setCash] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { tz: browserTzOffset() };
      if (from) params.from = from;
      if (to) params.to = to;
      setCash(await getCashDrawerSummary(params));
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

  if (loading) return <div className="p-10 text-center text-stone-600">Carregando…</div>;

  if (!cash) return <div className="p-10 text-center text-stone-600">Nenhum caixa no período.</div>;

  const view = buildCashReportView(cash);

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

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCard label="Fundo" value={fmtMoney(view.totalOpening)} />
        <StatCard label="Vendas $" value={fmtMoney(view.totalSales)} />
        <StatCard label="Esperado" value={fmtMoney(view.totalExpected)} />
        <StatCard
          label="Diferença"
          value={`${view.totalDifference > 0 ? "+" : ""}${fmtMoney(view.totalDifference)}`}
        />
      </div>

      {view.openCount > 0 && (
        <div className="text-stone-500 text-xs">
          <b className="text-amber-400">{view.openCount} sessão(ões) em aberto</b> no período —{" "}
          {fmtMoney(view.openExpected)} ainda não contado.
        </div>
      )}

      <Section title={`Sessões (${view.sessions.length})`}>
        <div className="space-y-2">
          {view.sessions.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between text-sm bg-stone-900 border border-stone-800 rounded-xl px-3 py-2"
            >
              <div>
                <div className="font-medium">Aberto {toDate(s.openedAt)?.toLocaleString() ?? "—"}</div>
                <div className="text-stone-500 text-xs">
                  {s.isOpen ? "ainda aberto" : `fechado ${toDate(s.closedAt)?.toLocaleString() ?? "—"}`}
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
                  <div
                    className={`font-semibold ${
                      s.diff > 0 ? "text-emerald-400" : s.diff < 0 ? "text-red-400" : "text-stone-200"
                    }`}
                  >
                    {s.diff > 0 ? "+" : ""}
                    {fmtMoney(s.diff)}
                  </div>
                  <div className="text-stone-500 text-xs">esperado {fmtMoney(s.expected ?? 0)}</div>
                </div>
              )}
            </div>
          ))}
          {view.sessions.length === 0 && (
            <div className="text-stone-600 text-center py-6 text-sm">Nenhum caixa no período.</div>
          )}
        </div>
      </Section>
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