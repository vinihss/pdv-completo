import { request } from "./http.js";

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