import React, { useCallback, useEffect, useMemo, useState } from "react";
import { overviewReport, browserTzOffset, PERIOD_PRESETS, periodRange, groupByFor } from "@/entities/reports";
import { Section, Field, inputClass } from "@/shared/components";
import { formatBRL } from "@/shared/lib";
import SalesChart from "./SalesChart.jsx";

/**
 * Relatório "Visão geral": o que a loja fez, em uma tela.
 *
 * Só a curva de vendas por período — o detalhe por produto, forma de pagamento
 * e lista de comandas é do relatório de Pedidos, e o dinheiro contado é do
 * Fluxo de caixa. Esta tela existe para a pergunta de 3 segundos ("como foi o
 * mês?") não exigir abrir o relatório de pedidos e ler três blocos antes de
 * achar o número.
 */
export default function OverviewTab({ showToast }) {
  const [preset, setPreset] = useState("7d");
  const [range, setRange] = useState(() => periodRange("7d"));
  const [groupBy, setGroupBy] = useState(() => groupByFor("7d"));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await overviewReport({
          from: range.from,
          to: range.to,
          groupBy,
          // O dia do gráfico é o dia da loja: sem o offset, a venda das 22h
          // cai no dia seguinte.
          tz: browserTzOffset(),
        }),
      );
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
    }
  }, [range, groupBy, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  // Topo do gráfico (dia/mês anterior) para dar contexto de "para onde vai".
  const comparison = useMemo(() => {
    if (!data || data.series.length < 2) return null;
    const [first] = data.series;
    const last = data.series[data.series.length - 1];
    if (first.total === 0) return null;
    const delta = ((last.total - first.total) / first.total) * 100;
    return { delta, up: delta >= 0 };
  }, [data]);

  function pickPreset(id) {
    setPreset(id);
    setRange(periodRange(id));
    setGroupBy(groupByFor(id));
  }

  return (
    <div className="p-5 max-w-2xl mx-auto space-y-5">
      <div className="flex flex-wrap gap-1.5">
        {PERIOD_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => pickPreset(p.id)}
            aria-pressed={preset === p.id}
            className={`px-3 h-8 rounded-lg text-[13px] font-medium transition-colors ${
              preset === p.id
                ? "bg-amber-500 text-stone-950 font-semibold"
                : "bg-stone-900 border border-stone-800 text-stone-400 hover:text-stone-100"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="De">
          <input
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => {
              setRange((r) => ({ ...r, from: e.target.value }));
              setPreset("custom");
            }}
            className={inputClass}
          />
        </Field>
        <Field label="Até">
          <input
            type="date"
            value={range.to}
            min={range.from}
            onChange={(e) => {
              setRange((r) => ({ ...r, to: e.target.value }));
              setPreset("custom");
            }}
            className={inputClass}
          />
        </Field>
      </div>

      {loading && <div className="text-stone-600 text-center py-10">Carregando…</div>}

      {data && !loading && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatCard label="Total vendido" value={formatBRL(data.totals.totalSales)} />
            <StatCard label="Comandas" value={data.totals.orderCount} />
            <StatCard label="Ticket médio" value={formatBRL(data.totals.avgTicket)} />
            <StatCard
              label={data.groupBy === "hour" ? "Melhor hora" : "Melhor dia"}
              value={bestPeriodLabel(data.series)}
            />
          </div>

          <Section
            title="Vendas por período"
            subtitle={`${formatBRL(data.totals.totalSales)} em ${data.totals.orderCount} ${
              data.totals.orderCount === 1 ? "comanda" : "comandas"
            }`}
          >
            <SalesChart series={data.series} />
            {comparison && (
              <p className={`text-[12.5px] mt-2 ${comparison.up ? "text-emerald-400" : "text-red-400"}`}>
                {comparison.up ? "▲" : "▼"} {Math.abs(comparison.delta).toFixed(0)}% entre o primeiro e o
                último {data.groupBy === "hour" ? "horário" : "dia"} do período
              </p>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

/** Rótulo do bucket com maior venda; vazio quando o período não vendeu nada. */
function bestPeriodLabel(series) {
  const best = series.reduce((acc, p) => (p.total > (acc?.total ?? -1) ? p : acc), null);
  return best?.total > 0 ? best.label : "—";
}

function StatCard({ label, value }) {
  return (
    <div className="bg-stone-900 border border-stone-800 rounded-xl p-3 text-center">
      <div className="text-stone-500 text-[11px] mb-1">{label}</div>
      <div className="font-display font-bold text-sm">{value}</div>
    </div>
  );
}