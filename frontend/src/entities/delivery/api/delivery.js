import { request } from "@/shared/api/http";

// ---------- Deliveries (manager) ----------

export function listDeliveries(status) {
  return request("GET", `/manager/deliveries${status ? `?status=${status}` : ""}`);
}

export function listCouriers() {
  return request("GET", "/manager/couriers");
}

export function assignCourier(deliveryId, courierId) {
  return request("PATCH", `/manager/deliveries/${deliveryId}/assign`, { courierId });
}

// ---------- Entregas do entregador (perfil courier) ----------
export function listMyDeliveries() {
  return request("GET", "/courier/deliveries");
}

export function dispatchDelivery(deliveryId) {
  return request("PATCH", `/courier/deliveries/${deliveryId}/dispatch`);
}

export function deliverDelivery(deliveryId) {
  return request("PATCH", `/courier/deliveries/${deliveryId}/deliver`);
}

export function failDelivery(deliveryId, reason) {
  return request("PATCH", `/courier/deliveries/${deliveryId}/fail`, { reason });
}
