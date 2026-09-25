import { request } from "./http.js";
import { newCorrelationId } from "../lib/uuid.js";

// ---------- Stock (inventário — manager) ----------

export function listStock(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request("GET", `/stock${qs ? `?${qs}` : ""}`);
}

export function listStockMovements(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request("GET", `/stock/movements${qs ? `?${qs}` : ""}`);
}

// Compra (entrada) ou ajuste (Δ sinalizado). Idempotente: correlationId
// gerado aqui garante que retry do client não dobre o movimento.
export function registerStockMovement(productId, body) {
  return request("POST", `/stock/${productId}/movements`, {
    correlationId: newCorrelationId(),
    ...body,
  });
}