// Portado de frontend/src/shared/lib/server.js — ver lá o histórico.
// Adaptação RN: no aparelho não existe "mesma origem" nem `window.location`
// — a base do servidor é SEMPRE uma configuração persistida (MMKV via
// `storage`), e sem ela o app mostra a tela de setup. `currentServerLabel`
// devolve "" (não há origem de página para mostrar) e `wsUrl` devolve ""
// (pedir conexão sem base seria inventar origem).

import { DEFAULT_DAEMON_URL } from "./appConfig.js";
import { storage } from "./storage.js";

const STORAGE_KEY = "pdv:server";

// Padrão do build (EXPO_PUBLIC_DEFAULT_SERVER, quando informado): permite
// embutir a URL da nuvem no binary sem o usuário digitar nada. Vazio no dev.
const BUILD_DEFAULT = (process.env.EXPO_PUBLIC_DEFAULT_SERVER ?? "").trim().replace(/\/+$/, "");

function readStored() {
  try {
    return (storage.getItem(STORAGE_KEY) ?? "").trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function getServerBase() {
  return readStored() || BUILD_DEFAULT;
}

// Só http/https, sem barra no fim (a barra viraria `//api` na concatenação).
// Aceita caminho (`https://x.com/pdv`) para quem publica o app sob prefixo.
export function validateServerUrl(value) {
  const raw = (value ?? "").trim().replace(/\/+$/, "");
  if (!raw) return { ok: true, value: "" };
  if (!/^https?:\/\//i.test(raw)) {
    return { ok: false, error: "O endereço precisa começar com http:// ou https://" };
  }
  try {
    const u = new URL(raw);
    if (!u.hostname) return { ok: false, error: "Endereço inválido" };
    return { ok: true, value: `${u.origin}${u.pathname.replace(/\/+$/, "")}` };
  } catch {
    return { ok: false, error: "Endereço inválido" };
  }
}

export function setServerBase(value) {
  const { ok, value: normalized, error } = validateServerUrl(value);
  if (!ok) return { ok, error };
  try {
    storage.setItem(STORAGE_KEY, normalized);
  } catch {
    return { ok: false, error: "Não foi possível salvar neste dispositivo" };
  }
  return { ok: true, value: normalized };
}

// Para mostrar no login: o que está em uso agora. Sem config, "" (não há
// "origem da página" num aparelho — o web mostra `window.location.origin`).
export function currentServerLabel() {
  return getServerBase();
}

// O padrão do build, para a tela de login explicar o que "vazio" significa.
export function serverDefault() {
  return BUILD_DEFAULT;
}

export function apiUrl(path) {
  return `${getServerBase()}/api${path}`;
}

// Tag do backend (o que o health check devolve), para mostrar no login.
// Timeout por Promise.race: no RN o AbortSignal de fetch é menos confiável
// que no browser.
export async function fetchTag() {
  const base = getServerBase();
  if (!base) return null;
  try {
    const res = await Promise.race([
      fetch(`${base}/health`, { method: "GET" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    if (!res.ok) return null;
    const data = await res.json();
    return data.tag || null;
  } catch {
    return null;
  }
}

export function wsUrl() {
  const base = getServerBase();
  if (!base) return "";
  const u = new URL(base);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/realtime`;
}

// Foto de produto, logo da loja, foto de usuário: o backend devolve caminho
// relativo (`/uploads/...`), que no RN precisa da base do servidor. URL
// absoluta, `data:` e `blob:` passam intactos.
export function assetUrl(path) {
  if (!path) return path;
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return `${getServerBase()}${path}`;
}

// ---------------------------------------------------------------------------
// Daemon de impressão (ESC/POS) — Frente 2 vai ler daqui para decidir se o
// botão "Imprimir" aparece. Não existe daemon no celular: quando a loja tem o
// daemon numa máquina da LAN, o endereço é configurado aqui (fica em MMKV).
// Sem ele, `isDaemonConfigured()` é false e o botão fica escondido.
//
// O padrão do web (`DEFAULT_DAEMON_URL` loopback) não faz sentido num
// telefone — loopback seria o próprio aparelho — por isso o RN começa com "".
// ---------------------------------------------------------------------------

const DAEMON_KEY = "pdv:daemon";

/** Endereço do daemon que a loja informou, ou "" (não configurado). */
export function getDaemonBase() {
  try {
    return (storage.getItem(DAEMON_KEY) ?? "").trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** Há daemon configurado neste aparelho? (base pro botão "Imprimir".) */
export function isDaemonConfigured() {
  return Boolean(getDaemonBase());
}

export function setDaemonBase(value) {
  const { ok, value: normalized, error } = validateServerUrl(value);
  if (!ok) return { ok, error };
  try {
    storage.setItem(DAEMON_KEY, normalized);
  } catch {
    return { ok: false, error: "Não foi possível salvar neste dispositivo" };
  }
  return { ok: true, value: normalized };
}

// Conveniência: o valor que o appConfig espera (padrão loopback quando nada
// configurado — mantém a semântica do web em `normalizeConfig`).
export function effectiveDaemonBase() {
  return getDaemonBase() || DEFAULT_DAEMON_URL;
}