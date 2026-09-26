import { request } from "./http.js";
import { newCorrelationId } from "../lib/uuid.js";

// Página pública de delivery (sem auth — ver public.routes.ts)

export function getPublicMenu() {
  return request("GET", "/public/menu");
}

export function lookupPublicCustomer(phone) {
  return request("POST", "/public/customers/lookup", { phone });
}

export function createPublicCustomer(name, phone) {
  return request("POST", "/public/customers", { correlationId: newCorrelationId(), name, phone });
}

export function addPublicAddress(customerId, address) {
  return request("POST", `/public/customers/${customerId}/addresses`, {
    correlationId: newCorrelationId(),
    ...address,
  });
}

export function createPublicOrder(body) {
  return request("POST", "/public/orders", { correlationId: newCorrelationId(), ...body });
}

export function getPublicOrderStatus(orderId) {
  return request("GET", `/public/orders/${orderId}/status`);
}

// Cancelamento pelo cliente — phone é o dono do pedido (o UUID sozinho
// não autoriza); só em stage cancelável (backend valida via máquina).
export function cancelPublicOrder(orderId, customerPhone) {
  return request("POST", `/public/orders/${orderId}/cancel`, {
    correlationId: newCorrelationId(),
    customerPhone,
  });
}

// Pedido em andamento pra retomada (banner "Ver status" na página).
export function getActivePublicOrder(phone) {
  return request("POST", "/public/orders/active", { phone });
}

// ---------- Carrinho server-side (continuação do pedido) ----------

export function getPublicCart(phone) {
  return request("GET", `/public/cart?phone=${encodeURIComponent(phone)}`);
}

// items: [{ productId, quantity, selectedVariations?, notes }]
export function savePublicCart(phone, items) {
  return request("PUT", "/public/cart", { phone, items });
}

export function clearPublicCart(phone) {
  return request("DELETE", "/public/cart", { phone });
}