import React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatBRL } from "@/shared/lib";

/**
 * Valor gasto pelo cliente nos últimos N dias.
 *
 * Barras (e não linha como no `SalesChart` do relatório) porque aqui a
 * pergunta é outra: o gerente quer **um dia** — "quando foi que ele veio?" — e
 * só o dia é clicável. A paleta, o `tickFormatter` e o `isAnimationActive={false}`
 * seguem o relatório, para as duas telas do gerente lerem como a mesma coisa.
 *
 * O backend manda um ponto por dia do período, com `total: 0` nos dias sem
 * venda: eixo com todos os dias é o que faz o silêncio ser visível. Dia sem
 * venda **também** é clicável — é assim que se acha o dia em que ele não veio.
 *
 * Sem nenhum dia com valor, texto. Eixo vazio com grade e sem barra parece
 * bug, e o gerente não sabe dizer se falhou ou se o cliente não veio.
 */
export default function CustomerSpentChart({ series = [], loading, selectedDay, onSelectDay, height = 190 }) {
  if (loading) {
    return (
      <div className="text-stone-600 text-center py-10" data-testid="customer-chart-loading">
        Carregando…
      </div>
    );
  }

  const temVenda = series.some((p) => Number(p.total) > 0);
  if (series.length === 0 || !temVenda) {
    return (
      <div className="text-stone-600 text-center py-8 text-sm" data-testid="customer-chart-empty">
        Sem compras no período.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div style={{ height }} data-testid="customer-chart">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#292524" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: "#78716c", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "#292524" }}
              interval="preserveStartEnd"
              minTickGap={8}
            />
            <YAxis
              tick={{ fill: "#78716c", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(v) => formatBRL(v)}
            />
            <Tooltip content={<DayTooltip />} cursor={{ fill: "#57534e", fillOpacity: 0.12 }} />
            <Bar
              dataKey="total"
              fill="#f59e0b"
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
              cursor="pointer"
              onClick={(entry, index) => {
                const ponto = series[index] ?? entry;
                if (ponto?.day) onSelectDay(ponto.day);
              }}
            >
              {series.map((p) => (
                <Cell key={p.day} fill={p.day === selectedDay ? "#fde68a" : "#f59e0b"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-stone-600 text-[11px] text-center">
        Toque em um dia do gráfico para ver os pedidos dele.
      </p>
    </div>
  );
}

function DayTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="bg-stone-900 border border-stone-700 rounded-lg px-2.5 py-1.5 text-xs shadow-lg">
      <div className="text-stone-500 mb-0.5">{point.label}</div>
      <div className="text-amber-400 font-bold">{formatBRL(point.total)}</div>
      <div className="text-stone-400 mt-0.5">
        {point.orderCount} {point.orderCount === 1 ? "comanda" : "comandas"}
      </div>
    </div>
  );
}
