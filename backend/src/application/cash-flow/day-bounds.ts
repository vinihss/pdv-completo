// Limites de dia para o resumo por período do caixa. Padrão é UTC; com um
// offset `±HH:MM` (fuso local da loja) o dia começa/termina deslocado do UTC.
// Limitação: DST usa o offset do request (sem histórico por dia).

export function parseTzOffset(tz?: string): number {
  if (!tz) return 0;
  const m = tz.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const total = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -total : total;
}

export function isValidTz(tz?: string): boolean {
  if (!tz) return true;
  const m = tz.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return false;
  const total = Number(m[2]) * 60 + Number(m[3]);
  return total <= 12 * 60;
}

// Normaliza "YYYY-MM-DD" para o início do dia (UTC). Mantém ISO completo.
export function dayStart(input: string, tz?: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const [y, m, d] = input.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - parseTzOffset(tz) * 60000).toISOString();
}

// Normaliza "YYYY-MM-DD" para o fim do dia (UTC). Mantém ISO completo.
export function dayEnd(input: string, tz?: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const [y, m, d] = input.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - parseTzOffset(tz) * 60000).toISOString();
}