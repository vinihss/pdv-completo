/**
 * Model de domínio para settlements (conciliação de marketplace).
 *
 * Calcula payout a partir dos valores e fornece labels para UI.
 */

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

/** Canais conhecidos de marketplace. */
export const CHANNELS = [
  { id: "ifood", label: "iFood" },
  { id: "rappi", label: "Rappi" },
  { id: "uber_eats", label: "Uber Eats" },
  { id: "direct", label: "Direto (sem marketplace)" },
];

export function channelLabel(channel) {
  return CHANNELS.find((c) => c.id === channel)?.label ?? channel ?? "—";
}

/** Status de payout com label e cor. */
export const PAYOUT_STATUSES = [
  { id: "pending", label: "Pendente", tone: "amber" },
  { id: "paid", label: "Recebido", tone: "emerald" },
  { id: "failed", label: "Falhou", tone: "red" },
];

export function payoutStatusLabel(status) {
  return PAYOUT_STATUSES.find((s) => s.id === status)?.label ?? status ?? "—";
}

export function payoutStatusTone(status) {
  return PAYOUT_STATUSES.find((s) => s.id === status)?.tone ?? "stone";
}

/**
 * Calcula o payout líquido: bruto − comissão − taxa marketplace − subsídio entrega.
 * Se o settlement já traz payoutAmount (o backend calcula por padrão), usa ele.
 */
export function calcPayoutAmount({ grossAmount, commissionAmount, marketplaceFee = 0, deliveryFeeSubsidy = 0 }) {
  return round2((grossAmount ?? 0) - (commissionAmount ?? 0) - (marketplaceFee ?? 0) - (deliveryFeeSubsidy ?? 0));
}

/** Formata data ISO em string legível (pt-BR) ou "—" se ausente. */
export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Retorna a data de hoje no formato ISO para input type="date". */
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Soma totais de uma lista de settlements.
 * @param {Array} settlements
 * @returns {{ grossTotal: number, commissionTotal: number, feesTotal: number, payoutPending: number, payoutReceived: number, payoutTotal: number }}
 */
export function sumSettlements(settlements = []) {
  let grossTotal = 0;
  let commissionTotal = 0;
  let feesTotal = 0;
  let payoutPending = 0;
  let payoutReceived = 0;

  for (const s of settlements) {
    grossTotal += Number(s.grossAmount ?? 0);
    commissionTotal += Number(s.commissionAmount ?? 0);
    feesTotal += Number(s.marketplaceFee ?? 0) + Number(s.deliveryFeeSubsidy ?? 0);
    const payout = Number(s.payoutAmount ?? 0);
    if (s.payoutStatus === "paid") payoutReceived += payout;
    else payoutPending += payout;
  }

  return {
    grossTotal: round2(grossTotal),
    commissionTotal: round2(commissionTotal),
    feesTotal: round2(feesTotal),
    payoutPending: round2(payoutPending),
    payoutReceived: round2(payoutReceived),
    payoutTotal: round2(payoutPending + payoutReceived),
  };
}
