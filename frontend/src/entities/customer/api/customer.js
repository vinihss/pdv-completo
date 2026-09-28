import { request } from "@/shared/api/http";

// Busca leve do garçom (abrir comanda com cliente) — array simples.
export function searchCustomers(q) {
  return request("GET", `/customers/search${q ? `?q=${encodeURIComponent(q)}` : ""}`);
}

// ---------- Clientes (manutenção gerente/caixa) ----------

export async function listAllCustomers(params = {}) {
  const size = 200;
  let offset = 0;
  const all = [];
  for (;;) {
    const { data, total } = await request(
      "GET",
      `/customers?${new URLSearchParams({ ...params, limit: String(size), offset: String(offset) })}`
    );
    all.push(...data);
    offset += data.length;
    if (all.length >= total || data.length === 0) break;
  }
  return { data: all, total: all.length };
}

export function getCustomer(id) {
  return request("GET", `/customers/${id}`);
}

export function createCustomer(body) {
  return request("POST", "/customers", body);
}

export function updateCustomer(id, body) {
  return request("PATCH", `/customers/${id}`, body);
}

export function addCustomerAddress(customerId, address) {
  return request("POST", `/customers/${customerId}/addresses`, address);
}

export function setDefaultCustomerAddress(customerId, addressId) {
  return request("POST", `/customers/${customerId}/addresses/${addressId}/default`);
}

export function deleteCustomerAddress(customerId, addressId) {
  return request("DELETE", `/customers/${customerId}/addresses/${addressId}`);
}
