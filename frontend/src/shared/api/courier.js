import { request } from "./http.js";

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