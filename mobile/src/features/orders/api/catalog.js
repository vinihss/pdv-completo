// API do catálogo que o fluxo do garçom consome (mesas, clientes, categorias,
// produtos). No web cada um mora numa entity (entities/table, customer,
// category, product); aqui — por regra de isolamento do módulo mobile — vivem
// em features/orders/api. Contratos idênticos aos web (mesmos endpoints e
// formatos de payload).

import { request } from "@/shared/api/http";

export function listTables() {
  return request("GET", "/tables");
}

// Busca leve do garçom (abrir comanda com cliente) — array simples.
export function searchCustomers(q) {
  return request("GET", `/customers/search${q ? `?q=${encodeURIComponent(q)}` : ""}`);
}

export function createCustomer(body) {
  return request("POST", "/customers", body);
}

export function listCategories() {
  return request("GET", "/categories");
}

// Busca todas as páginas de produtos (backend pagina em limit/offset) — o
// lançamento precisa do catálogo inteiro ativo.
export async function listAllProducts(params = {}) {
  const size = 200;
  let offset = 0;
  const all = [];
  for (;;) {
    const { data, total } = await request(
      "GET",
      `/products?${new URLSearchParams({ ...params, limit: String(size), offset: String(offset) })}`
    );
    all.push(...data);
    offset += data.length;
    if (all.length >= total || data.length === 0) break;
  }
  return { data: all, total: all.length };
}