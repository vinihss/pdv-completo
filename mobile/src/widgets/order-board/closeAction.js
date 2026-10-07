// Regra do rodapé "Fechar conta" (AC 03-acceptance-criteria § fechar conta) —
// extraída do OrderDetailScreen em função pura para ser testável sem render.
// O componente só cuida de estado/efeitos; quem decide o que o rodapé faz é aqui.
const PAYMENT_CODES = new Set([
  "payment_not_registered",
  "payment_not_confirmed",
  "invalid_payment_total",
]);

/**
 * O que o botão "Fechar conta" deve fazer num toque:
 * - "blocked": tem item pendente → o botão fica desabilitado e o aviso lista os nomes;
 * - "payment": sem pendência e sem pagamento registrado → leva para a tela de pagamento;
 * - "close": tudo certo → fecha a comanda.
 */
export function closePlan({ pendingCount, hasPayments }) {
  if (pendingCount > 0) return "blocked";
  return hasPayments ? "close" : "payment";
}

/**
 * Como reagir à falha do `closeOrder`:
 * - "pending": o backend recusou por item pendente → aviso com os NOMES (AC);
 * - "payment": o pagamento é o problema → leva para a tela de pagamento;
 * - "toast": qualquer outro erro → só informa.
 */
export function closeFailure(error) {
  if (error?.code === "pending_items") {
    const names = (error.details?.pendingItems ?? []).map((i) => i.name).filter(Boolean);
    return {
      kind: "pending",
      names,
      message: names.length > 0 ? `Ainda há itens pendentes: ${names.join(", ")}` : "Ainda há itens pendentes.",
    };
  }
  if (PAYMENT_CODES.has(error?.code)) return { kind: "payment" };
  return { kind: "toast", message: error?.message ?? "Não foi possível fechar a comanda." };
}
