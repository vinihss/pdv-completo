import { request } from "@/shared/api/http";
import { newCorrelationId } from "@/shared/lib";

/**
 * Lista settlements com filtros opcionais.
 *
 * @param {Object} filters
 * @param {string} [filters.channel] - Canal (ex: "ifood")
 * @param {string} [filters.payout_status] - Status do payout ("pending" | "paid" | "failed")
 * @param {string} [filters.from] - Data inicial (ISO)
 * @param {string} [filters.to] - Data final (ISO)
 */
export function listSettlements(filters = {}) {
  const params = new URLSearchParams();
  if (filters.channel) params.append("channel", filters.channel);
  if (filters.payout_status) params.append("payout_status", filters.payout_status);
  if (filters.from) params.append("from", filters.from);
  if (filters.to) params.append("to", filters.to);

  const qs = params.toString();
  return request("GET", `/settlements${qs ? `?${qs}` : ""}`);
}

/**
 * Busca settlement de um pedido específico.
 *
 * @param {string} orderId - ID do pedido
 */
export function getSettlementByOrderId(orderId) {
  return request("GET", `/settlements/by-order/${orderId}`);
}

/**
 * Registra um novo settlement.
 *
 * @param {Object} data
 * @param {string} data.orderId - ID do pedido
 * @param {string} data.channel - Canal (ex: "ifood")
 * @param {number} data.grossAmount - Valor bruto
 * @param {number} data.commissionAmount - Comissão
 * @param {number} [data.marketplaceFee] - Taxa do marketplace
 * @param {number} [data.deliveryFeeSubsidy] - Subsídio de entrega
 * @param {number} [data.payoutAmount] - Payout (calculado automaticamente se omitido)
 * @param {string} [data.payoutExpectedAt] - Data esperada de recebimento (ISO)
 * @param {string} [data.externalRef] - Referência externa
 * @param {string} [data.notes] - Observações
 */
export function registerSettlement(data) {
  return request("POST", "/settlements", {
    correlationId: newCorrelationId(),
    ...data,
  });
}

/**
 * Marca settlement como recebido (pago).
 *
 * @param {string} settlementId - ID do settlement
 * @param {string} payoutSettledAt - Data efetiva de recebimento (ISO)
 */
export function markSettled(settlementId, payoutSettledAt) {
  return request("PATCH", `/settlements/${settlementId}/settle`, {
    correlationId: newCorrelationId(),
    payoutSettledAt,
  });
}
