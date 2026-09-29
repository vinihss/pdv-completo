// Config do aplicativo (modo local × cloud) e derivação das URLs de
// infraestrutura a partir dela.
//
// É o lugar único que sabe "de onde vem a URL da API". No web não existe
// config: a mesma origem que serve o index já serve o `/api` (Caddy/nginx),
// então o comportamento de sempre é preservado sem tocar em nada.
//
// No desktop a config vem do arquivo do cliente (ver `app_config` em
// `src-tauri/src/lib.rs`) e a API pode estar em outra máquina — daí a
// URL absoluta.

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

/** Injeta a config (vinda do app providers). `null` volta ao modo web. */
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
 * Base das chamadas REST. Web sem config → `/api` (mesma origem, como
 * sempre). Desktop → origem configurada + `/api`.
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
 * URL do WebSocket. No web cai no host atual (comportamento atual, via
 * `window.location`); no desktop deriva da origem configurada, com `wss:`
 * quando ela é https.
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
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${suffix}`;
}

/** Base do daemon de impressão (loopback por padrão). */
export function daemonBase() {
  return config?.daemonUrl || DEFAULT_DAEMON_URL;
}
