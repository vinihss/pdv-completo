import { request, upload } from "./http.js";

// ---------- Products ----------

export function listProducts(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request("GET", `/products${qs ? `?${qs}` : ""}`);
}

// Busca todas as páginas de produtos (backend pagina em limit/offset).
// Evita o truncamento silencioso em 50 quando a tela precisa do catálogo
// inteiro (garçom/cozinha/lista do gerente).
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

export function createProduct(body) {
  return request("POST", "/products", body);
}

export function updateProduct(id, body) {
  return request("PATCH", `/products/${id}`, body);
}

export function setProductActive(id, active) {
  return request("PATCH", `/products/${id}/${active ? "activate" : "deactivate"}`);
}

export function uploadProductImage(id, file) {
  return upload(`/products/${id}/image`, "image", file);
}

export function removeProductImage(id) {
  return request("DELETE", `/products/${id}/image`);
}

// ---------- Categories ----------

export function listCategories() {
  return request("GET", "/categories");
}

export function createCategory(body) {
  return request("POST", "/categories", body);
}

export function updateCategory(id, body) {
  return request("PATCH", `/categories/${id}`, body);
}

export function deleteCategory(id) {
  return request("DELETE", `/categories/${id}`);
}

// ---------- Kitchen groups (estações de produção) ----------

export function listKitchenGroups() {
  return request("GET", "/kitchen-groups");
}

export function createKitchenGroup(body) {
  return request("POST", "/kitchen-groups", body);
}

export function updateKitchenGroup(id, body) {
  return request("PATCH", `/kitchen-groups/${id}`, body);
}

export function deleteKitchenGroup(id) {
  return request("DELETE", `/kitchen-groups/${id}`);
}