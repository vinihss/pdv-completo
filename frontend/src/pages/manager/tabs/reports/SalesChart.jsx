import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts";
import { formatBRL } from "@/shared/lib";

/**
 * Gráfico de vendas por período.
 *
 * Linha (e não barra) porque a pergunta é "como subiu/desceu", não "quanto em
 * cada dia": com 30 dias, barras de um dia quase invisível disputam largura com
 * o eixo e a linha responde a tendência de relance.
 *
 * Sem lib de gráfico pronta no projeto, e instalar uma só para isto traz 200kb
 * de dependência para um SVG com dois eixos — daí o desenho à mão. O que não
 * dá para reinventar é o eixo X: o backend já devolve `label` pronto (pt-BR,
 * "01/10"), e rotular com `toLocaleDateString` aqui reintroduziria a diferença
 * de fuso que o agrupamento do backend existe para evitar.
 *
 * Sem dados: devolve um aviso em texto, nunca um eixo vazio — um gráfico com
 * grade e sem traço parece quebrado, e o gerente não sabe se é bug ou venda zero.
 */
export default function SalesChart({ series = [], height = 220 }) {
  if (series.length === 0) {
    return (
      <div className="flex items-center justify-center text-stone-600 text-sm" style={{ height }}>
        Sem vendas no período.
      </div>
    );
  }

  // Sem variação no gráfico: uma linha reta não diz nada, e o eixo Y
  // achatado em zero esconde que o valor é o mesmo todo dia. Ressaia o mínimo.
  const values = series.map((p) => p.total);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const flat = max === min;
  const pad = (max - min) * 0.15 || Math.max(max * 0.1, 1);
  const domain = flat ? [0, max + pad] : [Math.max(0, min - pad), max + pad];

  return (
    <div style={{ height }} data-testid="sales-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
            domain={domain}
            tickFormatter={(v) => formatBRL(v)}
          />
          <Tooltip
            content={<SalesTooltip />}
            cursor={{ stroke: "#57534e", strokeWidth: 1 }}
          />
          <Line
            type="monotone"
            dataKey="total"
            stroke="#f59e0b"
            strokeWidth={2}
            dot={{ r: 2, fill: "#f59e0b", strokeWidth: 0 }}
            activeDot={{ r: 4, fill: "#f59e0b", strokeWidth: 0 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function SalesTooltip({ active, payload }) {
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