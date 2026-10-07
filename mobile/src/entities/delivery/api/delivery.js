// Copiado de frontend/src/entities/delivery/api/delivery.js (1:1).
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

// Correção de status pelo balcão. `reason` é obrigatório na prática quando o
// destino é `cancelled`/`failed` — a tela pede antes de chamar, porque o motivo
// é o texto que o cliente recebe na notificação.
export function setDeliveryStatus(deliveryId, status, reason) {
  return request("PATCH", `/manager/deliveries/${deliveryId}/status`, {
    status,
    ...(reason ? { reason } : {}),
  });
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