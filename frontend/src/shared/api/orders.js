import { request } from "./http.js";
import { newCorrelationId } from "../lib/uuid.js";

export function listOrders(status, limit) {
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (limit) qs.set("limit", String(limit));
  return request("GET", `/orders${qs.toString() ? `?${qs}` : ""}`);
}

export function getOrder(id) {
  return request("GET", `/orders/${id}`);
}

export function listTables() {
  return request("GET", "/tables");
}

export function openOrder(body) {
  return request("POST", "/orders", { correlationId: newCorrelationId(), ...body });
}

export function addItems(orderId, items) {
  return request("POST", `/orders/${orderId}/items`, { correlationId: newCorrelationId(), items });
}

export function updateItemStatus(orderId, itemId, status, expectedVersion) {
  return request("PATCH", `/orders/${orderId}/items/${itemId}`, { status, expectedVersion });
}

export function deleteItem(orderId, itemId) {
  return request("DELETE", `/orders/${orderId}/items/${itemId}`);
}

export function registerPayment(orderId, paymentMethod, confirmed) {
  return request("PATCH", `/orders/${orderId}/payment`, { paymentMethod, confirmed });
}

export function closeOrder(orderId) {
  return request("PATCH", `/orders/${orderId}/close`, { correlationId: newCorrelationId() });
}

export function cancelOrder(orderId, reason) {
  return request("PATCH", `/orders/${orderId}/cancel`, { correlationId: newCorrelationId(), reason });
}