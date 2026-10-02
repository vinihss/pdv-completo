export function toDate(ts) {
  if (!ts) return null;
  return ts.includes("T") ? new Date(ts) : new Date(ts.replace(" ", "T") + "Z");
}

export function formatDateTime(ts) {
  const d = toDate(ts);
  if (!d || Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function digitsOnly(v) {
  return (v ?? "").replace(/\D/g, "");
}

export function maskPhone(raw) {
  const d = digitsOnly(raw).slice(0, 11);
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

// Máscara de CEP (00000-000) e de UF (2 letras). Ficam aqui porque dois
// formulários de endereço do app precisam deles — o do gerente (editar cliente)
// e o da página pública — e cada um com o seu já era o mesmo campo escrito de
// duas maneiras.
export function maskCep(raw) {
  const d = digitsOnly(raw).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

export function maskState(raw) {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 2);
}

export function formatAddress(a) {
  if (!a) return "";
  const cep = a.cep ? `${a.cep} · ` : "";
  const uf = a.state ? ` - ${a.state}` : "";
  return `${cep}${a.street}, ${a.number}${a.complement ? ` - ${a.complement}` : ""} · ${a.neighborhood}, ${a.city}${uf}`;
}

export function minutesSince(ts, now = Date.now()) {
  const d = toDate(ts);
  if (!d) return 0;
  return Math.max(0, (now - d.getTime()) / 60000);
}

export function initials(name) {
  return (name ?? "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}

export function variationsText(selectedVariations) {
  return Object.values(selectedVariations ?? {})
    .map((v) => (Array.isArray(v) ? v.join(", ") : v))
    .filter(Boolean)
    .join(", ");
}
