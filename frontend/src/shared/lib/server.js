// Base do servidor — onde a API e os assets ficam.
//
// No navegador (PWA) a API está na mesma origem: a base é `""` e as URLs
// continuam relativas (`/api/...`), que é o comportamento histórico do app e
// o que os testes existing esperam.
//
// No app desktop (Tauri) a origem da página é o próprio pacote (`tauri://localhost`),
// então um `/api` relativo apontaria para dentro do app em vez do backend. Por
// isso a base é uma configuração persistida: o usuário troca o servidor uma
// vez e o resto do app só chama `apiUrl`/`wsUrl`/`assetUrl`.

const STORAGE_KEY = "pdv:server";

// Padrão do build desktop (ver `desktop:build` / build-app.sh). Vazio no build
// web, para não amarrar a URL de ninguém no bundle do navegador.
const BUILD_DEFAULT = (import.meta.env?.VITE_DEFAULT_SERVER ?? "").trim().replace(/\/+$/, "");

function readStored() {
  try {
    return (localStorage.getItem(STORAGE_KEY) ?? "").trim().replace(/\/+$/, "");
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
    localStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    return { ok: false, error: "Não foi possível salvar neste dispositivo" };
  }
  return { ok: true, value: normalized };
}

// Para mostrar no login: o que está em uso agora, ou a origem da página.
export function currentServerLabel() {
  return getServerBase() || (typeof window !== "undefined" ? window.location.origin : "");
}

// O padrão do build, para a tela de login explicar o que "vazio" significa.
export function serverDefault() {
  return BUILD_DEFAULT;
}

export function apiUrl(path) {
  return `${getServerBase()}/api${path}`;
}

export async function fetchTag() {
  try {
    const res = await fetch(`${getServerBase()}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.tag || null;
  } catch {
    return null;
  }
}

export function wsUrl() {
  const base = getServerBase();
  if (!base) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/realtime`;
  }
  const u = new URL(base);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/realtime`;
}

// Foto de produto, logo da loja, foto de usuário: o backend devolve caminho
// relativo (`/uploads/...`), que no desktop precisa da base do servidor.
// URL absoluta, `data:` e `blob:` passam intactos.
export function assetUrl(path) {
  if (!path) return path;
  if (/^(https?:|data:|blob:|tauri:)/i.test(path)) return path;
  return `${getServerBase()}${path}`;
}
