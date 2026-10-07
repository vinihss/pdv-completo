// Portado de frontend/src/shared/api/http.js — ver lá o histórico.
// Adaptação RN: o `fetch` global do React Native é o que é (app nativo não
// sofre CORS — sem plugin nenhum) e não existe `isDesktop`/plugin http do
// Tauri aqui. Mesma API pública: `setAuthToken`, `setUnauthorizedHandler`,
// `request`, `upload`, `pingApi`.

import { apiBase, originBase } from "@/shared/lib";

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

  const res = await fetch(`${apiBase()}${path}`, {
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

// Upload multipart (foto de produto). No RN o FormData recebe o arquivo como
// `{ uri, name, type }` — quem chama monta isso; o Content-Type do multipart o
// fetch monta sozinho (sem header manual, como no web).
async function upload(path, fieldName, file) {
  const form = new FormData();
  form.append(fieldName, file);
  const headers = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(`${apiBase()}${path}`, { method: "POST", headers, body: form });

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
// http://127.0.0.1:3000/health (no release Android, http://<ip-lan>:3000).
// Sem servidor configurado devolve false — a tela de setup é quem decide.
//
// Timeout por Promise.race: o fetch do RN (e o AbortController no release
// Android) não garante o `signal` — mesma razão do plugin do Tauri no web.
export async function pingApi(timeoutMs = 5000) {
  const base = originBase();
  if (!base) return false;
  const url = `${base}/health`;
  let timer;
  try {
    const res = await Promise.race([
      fetch(url, { method: "GET" }),
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