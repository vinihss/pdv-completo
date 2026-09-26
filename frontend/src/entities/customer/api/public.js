import { request } from "@/shared/api/http";
import { newCorrelationId } from "@/shared/lib/uuid";

// Identificação do cliente na página pública (sem auth).
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
