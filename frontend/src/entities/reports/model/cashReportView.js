import { formatBRL } from "@/shared/lib";

// Lógica pura do relatório de caixa, isolada do JSX para ser testável.
// O backend já agrega totais só de sessões fechadas (ver cash-flow.usecases).
// Aqui cuidamos de exibição segura (sessão aberta não tem counted/difference).

export function browserTzOffset() {
  const mins = -new Date().getTimezoneOffset(); // +180 → +03:00
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}

export function isOpenSession(session) {
  return session.status === "open";
}

// Diferença exibível: `null` para sessão aberta (ainda não foi contada).
export function sessionDiff(session) {
  return isOpenSession(session) ? null : session.difference;
}

// Linhas prontas pro JSX renderizar sem `null.toFixed` — sessão aberta vira
// rótulo "em aberto" + esperado ao vivo.
export function buildCashReportView(cash) {
  const sessions = (cash?.sessions ?? []).map((s) => ({
    ...s,
    isOpen: isOpenSession(s),
    diff: sessionDiff(s),
  }));
  return {
    sessions,
    openCount: cash?.openCount ?? sessions.filter((s) => s.isOpen).length,
    openExpected: cash?.openExpected ?? 0,
    totalOpening: cash?.totalOpening ?? 0,
    totalSales: cash?.totalSales ?? 0,
    totalExpected: cash?.totalExpected ?? 0,
    totalCounted: cash?.totalCounted ?? 0,
    totalDifference: cash?.totalDifference ?? 0,
  };
}

export const fmtMoney = formatBRL;