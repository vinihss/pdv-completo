import { request } from "@/shared/api/http";
import { newCorrelationId } from "@/shared/lib/uuid";

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
