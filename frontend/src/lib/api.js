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
  return crypto.randomUUID();
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

export const api = {
  // ---------- Auth ----------
  listLoginUsers: () => request("GET", "/auth/users"),
  login: (userId, pin) => request("POST", "/auth/login", { userId, pin }),

  // ---------- Store settings ----------
  getStoreSettings: () => request("GET", "/store-settings"),
  updateStoreSettings: (body) => request("PUT", "/store-settings", body),

  // ---------- Orders ----------
  listOrders: (status) => request("GET", `/orders${status ? `?status=${status}` : ""}`),
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

  // ---------- Products / Categories ----------
  listProducts: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request("GET", `/products${qs ? `?${qs}` : ""}`);
  },
  createProduct: (body) => request("POST", "/products", body),
  updateProduct: (id, body) => request("PATCH", `/products/${id}`, body),
  setProductActive: (id, active) => request("PATCH", `/products/${id}/${active ? "activate" : "deactivate"}`),

  listCategories: () => request("GET", "/categories"),
  createCategory: (body) => request("POST", "/categories", body),
  updateCategory: (id, body) => request("PATCH", `/categories/${id}`, body),
  deleteCategory: (id) => request("DELETE", `/categories/${id}`),

  // ---------- Users ----------
  listUsers: () => request("GET", "/users"),
  createUser: (body) => request("POST", "/users", body),
  updateUser: (id, body) => request("PATCH", `/users/${id}`, body),
  resetPin: (id) => request("PATCH", `/users/${id}/reset-pin`),

  // ---------- Customers ----------
  searchCustomers: (search) => request("GET", `/customers${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  createCustomer: (body) => request("POST", "/customers", body),

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
