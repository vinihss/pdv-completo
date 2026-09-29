// Client HTTP fino sobre a API real (ver 01-backend-spec.md §7).
// Nada de dados mockados: todo estado vem do backend.

import { apiBase, isDesktop, originBase } from "@/shared/lib";

let authToken = null;
let onUnauthorized = null;

export function setAuthToken(token) {
  authToken = token;
}

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

// No desktop a API pode estar em outra máquina e a webview roda na origem
// `tauri.localhost`, que o backend não libera no CORS. O plugin http do
// Tauri faz a requisição pelo Rust, que não sofre com CORS. No web é o
// `fetch` de sempre — o plugin nem é importado.
let desktopFetch = null;
function fetchImpl(input, init) {
  if (!isDesktop()) return fetch(input, init);
  if (!desktopFetch) {
    desktopFetch = import("@tauri-apps/plugin-http")
      .then((mod) => mod.fetch)
      // Sem o plugin registrado (build sem o Rust), ainda funciona se o
      // backend liberar a origem da webview.
      .catch(() => (...args) => fetch(...args));
  }
  return desktopFetch.then((f) => f(input, init));
}

async function request(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetchImpl(`${apiBase()}${path}`, {
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

  const res = await fetchImpl(`${apiBase()}${path}`, { method: "POST", headers, body: form });

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

// Health check do sistema. O Caddy expõe /health na RAIZ (fora do prefixo
// /api, ver deploy/Caddyfile) e o backend local responde em
// http://127.0.0.1:3000/health. É o que o boot do app desktop usa para
// saber se o sistema está no ar ANTES de mandar o gestor para o login.
//
// Timeout por Promise.race em vez de AbortController: o fetch do plugin do
// Tauri roda no Rust e o `signal` não é garantido lá.
export async function pingApi(timeoutMs = 5000) {
  const base = originBase();
  const url = base ? `${base}/health` : "/health";
  let timer;
  try {
    const res = await Promise.race([
      fetchImpl(url, { method: "GET" }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return Boolean(res?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export { request, upload };
