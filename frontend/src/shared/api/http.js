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

export { request, upload };