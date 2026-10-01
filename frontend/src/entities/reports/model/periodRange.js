/**
 * Períodos rápidos dos relatórios.
 *
 * Aqui porque os quatro relatórios do gerente compartilham a mesma noção de
 * "últimos 7 dias": duas implementações divergem na segunda mudança de filtro.
 *
 * Devolve `YYYY-MM-DD` local (o backend usa isso como dia da loja, não dia
 * UTC — ver `dayStart`/`dayEnd`). Montar com `toISOString()` daria o dia
 * errado para oeste de Greenwich à noite, que é justamente o horário de
 * fechar o caixa.
 */
export const PERIOD_PRESETS = [
  // `groupBy` mora no preset porque a granularidade é consequência da janela:
  // "hoje" por dia é um ponto só (um gráfico de uma barra não diz nada —
  // por isso `hour`), e um mês por dia fica ilegível no eixo X.
  { id: "today", label: "Hoje", days: 0, groupBy: "hour" },
  { id: "7d", label: "7 dias", days: 6, groupBy: "day" },
  { id: "30d", label: "30 dias", days: 29, groupBy: "day" },
  { id: "month", label: "Mês", days: null, groupBy: "day" },
];

function localDateKey(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `from`/`to` do preset, calculados a partir de `today` (para teste). */
export function periodRange(presetId, today = new Date()) {
  const preset = PERIOD_PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;

  if (preset.days === 0) {
    const todayKey = localDateKey(today);
    return { from: todayKey, to: todayKey };
  }

  if (preset.days === null) {
    return {
      from: localDateKey(new Date(today.getFullYear(), today.getMonth(), 1)),
      to: localDateKey(today),
    };
  }

  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - preset.days);
  return { from: localDateKey(from), to: localDateKey(today) };
}

/**
 * Granularidade que o gráfico usa por padrão em cada janela.
 *
 * Uma série por hora de um mês é ruído no eixo X; uma série por dia de uma
 * semana esconde a variação. É a regra que o gráfico precisa, não o que o
 * gerente pediu explicitamente — por isso ficar aqui, e não no botão.
 */
export function groupByFor(presetId) {
  const p = PERIOD_PRESETS.find((x) => x.id === presetId);
  return p?.groupBy ?? "day";
}