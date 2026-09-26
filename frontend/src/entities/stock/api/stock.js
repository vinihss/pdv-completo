import { request } from "@/shared/api/http";
import { newCorrelationId } from "@/shared/lib/uuid";

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

// ---------- Fornecedores (gerente) ----------
export function listSuppliers() { return request("GET", "/suppliers"); }
export function createSupplier(body) { return request("POST", "/suppliers", body); }
export function updateSupplier(id, body) { return request("PATCH", `/suppliers/${id}`, body); }

// ---------- Compras (gerente) ----------
export function createPurchase(body) {
  return request("POST", "/purchases", { correlationId: newCorrelationId(), ...body });
}
export function listPurchases(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request("GET", `/purchases${qs ? `?${qs}` : ""}`);
}
export function getPurchase(id) { return request("GET", `/purchases/${id}`); }

// ---------- Valorização (gerente) ----------
export function inventoryValue() { return request("GET", "/inventory/value"); }
