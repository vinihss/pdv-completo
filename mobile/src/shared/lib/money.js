// Copiado de frontend/src/shared/lib/money.js (1:1; Intl existe no Hermes).
// Helpers de formatação monetária (BRL).
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatBRL(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "R$ 0,00";
  return brl.format(n);
}

// Converte "R$ 1.234,56" (ou qualquer texto) no número correspondente.
export function parseBRL(text) {
  const digits = String(text ?? "").replace(/\D/g, "");
  return Number.parseInt(digits, 10) / 100 || 0;
}

// Mantém apenas dígitos e trata como centavos, formatando como moeda.
// Ex.: "12" -> "R$ 0,12"; "1234" -> "R$ 12,34"; "123456" -> "R$ 1.234,56".
export function maskCurrencyInput(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "").slice(0, 13);
  if (!digits) return "";
  const cents = Number.parseInt(digits, 10) || 0;
  return brl.format(cents / 100);
}

// Máscara de CNPJ (99.999.999/9999-99) ou CPF (999.999.999-99) conforme a
// quantidade de dígitos. Aceita texto parcial (durante a digitação).
export function maskCnpjCpf(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "").slice(0, 14);
  if (!digits) return "";
  if (digits.length <= 11) {
    return digits
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }
  return digits
    .replace(/(\d{2})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1/$2")
    .replace(/(\d{4})(\d{1,2})$/, "$1-$2");
}