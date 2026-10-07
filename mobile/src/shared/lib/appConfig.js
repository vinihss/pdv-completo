// Portado de frontend/src/shared/lib/appConfig.js — ver lá o histórico.
// Adaptação RN: não existe `window.location` (nem origem da página). Sem
// config, `wsEndpoint` devolve só o path — ninguém chega a conectar porque a
// tela de setup bloqueia o app antes (e `useRealtime` só abre socket com
// endpoint absoluto).

// Daemon de impressão local. Mesmo valor padrão do backend
// (PRINTER_DAEMON_URL em backend/src/config/env.ts).
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:8080";

export const DEFAULT_MODE = "local";

let config = null;

/**
 * Normaliza o que veio do arquivo (ou do formulário) para a forma canônica:
 * `mode` preenchido, strings sem espaço nas pontas e origem sem barra final.
 * Pure — testado sem DOM.
 */
export function normalizeConfig(raw) {
  const input = raw ?? {};
  const mode = input.mode === "cloud" ? "cloud" : "local";
  const apiBase = normalizeOrigin(input.apiBase);
  const daemonUrl = normalizeOrigin(input.daemonUrl) || DEFAULT_DAEMON_URL;
  return { mode, apiBase, daemonUrl };
}

/**
 * Aceita `app.exemplo.com.br` (vira https), `http://127.0.0.1:3000` (fica
 * como está) e devolve "" quando não tem nada. Sem esquema, rede local
 * assume http — https em IP privado quebra mais do que acerta.
 */
export function normalizeOrigin(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `${isLocalHost(raw) ? "http" : "https"}://${raw}`;
  try {
    const url = new URL(withScheme);
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function isLocalHost(raw) {
  return /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(
    raw,
  );
}

/** Injeta a config (vinda do boot/AppConfigProvider). `null` volta a "sem servidor". */
export function setAppConfig(next) {
  config = next ? normalizeConfig(next) : null;
}

export function getAppConfig() {
  return config;
}

/** Tem backend configurado? Enquanto falso, o app mostra a tela de setup. */
export function isApiConfigured() {
  return Boolean(config?.apiBase);
}

/**
 * Base das chamadas REST. Sem servidor configurado devolve "/api" (mesmo
 * valor do web) — no RN isso significa "não chamar": a tela de setup bloqueia
 * qualquer chamada que chegaria aqui.
 */
export function apiBase() {
  return config?.apiBase ? `${config.apiBase}/api` : "/api";
}

/**
 * Só a origem, sem `/api`. O health check do Caddy fica na raiz
 * (`handle /health`), fora do prefixo da API — por isso não dá para
 * derivar de `apiBase()`.
 */
export function originBase() {
  return config?.apiBase ?? "";
}

/**
 * URL do WebSocket. Deriva da origem configurada, com `wss:` quando ela é
 * https. Sem config devolve o path puro (`/realtime`): o app nativo não tem
 * "host atual" para inventar origem — quem precisa conectar passa antes pela
 * tela de setup.
 */
export function wsEndpoint(path) {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (config?.apiBase) {
    const url = new URL(config.apiBase);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${suffix}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  return suffix;
}

/** Base do daemon de impressão (loopback por padrão; no RN o padrão não serve — ver server.js). */
export function daemonBase() {
  return config?.daemonUrl || DEFAULT_DAEMON_URL;
}