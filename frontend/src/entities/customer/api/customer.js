import { request } from "@/shared/api/http";

export function searchCustomers(search) {
  return request("GET", `/customers${search ? `?search=${encodeURIComponent(search)}` : ""}`);
}

export function createCustomer(body) {
  return request("POST", "/customers", body);
}