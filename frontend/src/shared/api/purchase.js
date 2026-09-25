import { request } from "./http.js";
import { newCorrelationId } from "../lib/uuid.js";

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
