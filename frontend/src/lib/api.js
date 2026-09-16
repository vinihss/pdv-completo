// Client HTTP fino sobre a API real (ver 01-backend-spec.md §7).
// Nada de dados mockados: todo estado vem do backend.

const BASE = "/api";

let authToken = null;
let onUnauthorized = null;

export function setAuthToken(token) {
  authToken = token;
}

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

function newCorrelationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function request(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    onUnauthorized?.();
  }

  if (res.status === 204) return null;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await res.json() : null;

  if (!res.ok) {
    const err = new Error(payload?.error?.message ?? payload?.message ?? `Erro ${res.status}`);
    err.code = payload?.error?.code ?? payload?.code;
    err.status = res.status;
    err.details = payload?.error?.details ?? payload?.details;
    throw err;
  }

  return payload;
}

// Upload multipart (foto de produto). Não define Content-Type manualmente —
// o browser monta o boundary correto do FormData.
async function upload(path, fieldName, file) {
  const form = new FormData();
  form.append(fieldName, file);
  const headers = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: form });

  if (res.status === 401) {
    onUnauthorized?.();
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await res.json() : null;

  if (!res.ok) {
    const err = new Error(payload?.error?.message ?? payload?.message ?? `Erro ${res.status}`);
    err.code = payload?.error?.code ?? payload?.code;
    err.status = res.status;
    err.details = payload?.error?.details ?? payload?.details;
    throw err;
  }

  return payload;
}

export const api = {
  // ---------- Auth ----------
  listLoginUsers: () => request("GET", "/auth/users"),
  login: (userId, pin) => request("POST", "/auth/login", { userId, pin }),

  // ---------- Store settings ----------
  getStoreInfo: () => request("GET", "/store-info"),
  getStoreSettings: () => request("GET", "/store-settings"),
  updateStoreSettings: (body) => request("PUT", "/store-settings", body),
  uploadStoreLogo: (file) => upload("/store-settings/logo", "logo", file),
  removeStoreLogo: () => request("DELETE", "/store-settings/logo"),

  // ---------- Orders ----------
  listOrders: (status, limit) => {
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (limit) qs.set("limit", String(limit));
    return request("GET", `/orders${qs.toString() ? `?${qs}` : ""}`);
  },
  getOrder: (id) => request("GET", `/orders/${id}`),
  listTables: () => request("GET", "/tables"),
  openOrder: (body) => request("POST", "/orders", { correlationId: newCorrelationId(), ...body }),
  addItems: (orderId, items) => request("POST", `/orders/${orderId}/items`, { correlationId: newCorrelationId(), items }),
  updateItemStatus: (orderId, itemId, status, expectedVersion) =>
    request("PATCH", `/orders/${orderId}/items/${itemId}`, { status, expectedVersion }),
  deleteItem: (orderId, itemId) => request("DELETE", `/orders/${orderId}/items/${itemId}`),
  registerPayment: (orderId, paymentMethod, confirmed) =>
    request("PATCH", `/orders/${orderId}/payment`, { paymentMethod, confirmed }),
  closeOrder: (orderId) => request("PATCH", `/orders/${orderId}/close`, { correlationId: newCorrelationId() }),
  cancelOrder: (orderId, reason) => request("PATCH", `/orders/${orderId}/cancel`, { correlationId: newCorrelationId(), reason }),

  // ---------- Products / Categories ----------
  listProducts: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request("GET", `/products${qs ? `?${qs}` : ""}`);
  },
  // Busca todas as páginas de produtos (backend pagina em limit/offset).
  // Evita o truncamento silencioso em 50 quando a tela precisa do catálogo
  // inteiro (garçom/cozinha/lista do gerente).
  listAllProducts: async (params = {}) => {
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
  },
  createProduct: (body) => request("POST", "/products", body),
  updateProduct: (id, body) => request("PATCH", `/products/${id}`, body),
  setProductActive: (id, active) => request("PATCH", `/products/${id}/${active ? "activate" : "deactivate"}`),
  uploadProductImage: (id, file) => upload(`/products/${id}/image`, "image", file),
  removeProductImage: (id) => request("DELETE", `/products/${id}/image`),

  listCategories: () => request("GET", "/categories"),
  createCategory: (body) => request("POST", "/categories", body),
  updateCategory: (id, body) => request("PATCH", `/categories/${id}`, body),
  deleteCategory: (id) => request("DELETE", `/categories/${id}`),

  // ---------- Kitchen groups (estações de produção) ----------
  listKitchenGroups: () => request("GET", "/kitchen-groups"),
  createKitchenGroup: (body) => request("POST", "/kitchen-groups", body),
  updateKitchenGroup: (id, body) => request("PATCH", `/kitchen-groups/${id}`, body),
  deleteKitchenGroup: (id) => request("DELETE", `/kitchen-groups/${id}`),

  // ---------- Users ----------
  listUsers: () => request("GET", "/users"),
  createUser: (body) => request("POST", "/users", body),
  updateUser: (id, body) => request("PATCH", `/users/${id}`, body),
  resetPin: (id) => request("PATCH", `/users/${id}/reset-pin`),

  // ---------- Customers ----------
  searchCustomers: (search) => request("GET", `/customers${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  createCustomer: (body) => request("POST", "/customers", body),

  // ---------- Deliveries (manager) ----------
  listDeliveries: (status) => request("GET", `/manager/deliveries${status ? `?status=${status}` : ""}`),
  listCouriers: () => request("GET", "/manager/couriers"),
  assignCourier: (deliveryId, courierId) => request("PATCH", `/manager/deliveries/${deliveryId}/assign`, { courierId }),

  // ---------- iFood (manager) ----------
  getIfoodStatus: () => request("GET", "/ifood/status"),
  syncIfoodCatalog: () => request("POST", "/ifood/catalog-sync"),

  // ---------- Deliveries (courier) ----------
  listMyDeliveries: () => request("GET", "/courier/deliveries"),
  dispatchDelivery: (deliveryId) => request("PATCH", `/courier/deliveries/${deliveryId}/dispatch`),
  deliverDelivery: (deliveryId) => request("PATCH", `/courier/deliveries/${deliveryId}/deliver`),
  failDelivery: (deliveryId, reason) => request("PATCH", `/courier/deliveries/${deliveryId}/fail`, { reason }),

  // ---------- Página pública de delivery (sem auth — ver public.routes.ts) ----------
  getPublicMenu: () => request("GET", "/public/menu"),
  lookupPublicCustomer: (phone) => request("POST", "/public/customers/lookup", { phone }),
  createPublicCustomer: (name, phone) =>
    request("POST", "/public/customers", { correlationId: newCorrelationId(), name, phone }),
  addPublicAddress: (customerId, address) =>
    request("POST", `/public/customers/${customerId}/addresses`, { correlationId: newCorrelationId(), ...address }),
  createPublicOrder: (body) => request("POST", "/public/orders", { correlationId: newCorrelationId(), ...body }),
  getPublicOrderStatus: (orderId) => request("GET", `/public/orders/${orderId}/status`),

  // ---------- Reports / Audit ----------
  salesReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request("GET", `/reports/sales${qs ? `?${qs}` : ""}`);
  },
  auditLog: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request("GET", `/audit-log${qs ? `?${qs}` : ""}`);
  },
};
