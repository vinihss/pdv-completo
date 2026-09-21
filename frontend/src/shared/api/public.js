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