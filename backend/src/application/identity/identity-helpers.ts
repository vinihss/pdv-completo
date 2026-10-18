/**
 * Helpers PUROS do módulo de identidade (docs/26 §3-§4).
 *
 * Tudo aqui é determinístico ou randômico-simples, sem I/O e sem importar
 * `infra/`/`config`: hash do refresh token (SHA-256), token opaco, senha
 * temporária, normalização de email, política de senha e aritmética de prazos.
 * O roteamento de transporte (SMTP, banco) fica nos use cases e adapters.
 */
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { Errors } from "../../domain/errors.js";

// ---------- prazos (contrato §4) ----------

/** `accountToken` vale só para trocar senha e escolher empresa. */
export const ACCOUNT_TOKEN_TTL = "10m";
/** Token de tenant — 12h (decisão 10), mesmo prazo do login por PIN. */
export const TENANT_TOKEN_TTL = "12h";
/** Sessão de refresh por dispositivo: 30 dias, renovados a cada rotação. */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Link de recuperação de senha: ~30min (§3). */
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

// ---------- política de senha ----------

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
/** Senha temporária do convite (decisão 4): 10 caracteres, sem ambiguidade. */
const TEMP_PASSWORD_LENGTH = 10;

export function nowIso(): string {
  return new Date().toISOString();
}

export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** `true` quando `iso` já passou em relação a `now` (mesmo formato → ordem lexicográfica). */
export function isPast(iso: string, now: string): boolean {
  return Date.parse(iso) <= Date.parse(now);
}

// ---------- identificadores e tokens ----------

export function newId(): string {
  return randomUUID();
}

/** 256 bits de aleatoriedade (opaco para o cliente; o banco guarda só o hash). */
export function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const TEMP_PASSWORD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/**
 * Senha temporária do convite: 10 caracteres com alfabeto sem letras/dígitos
 * parecidos (0/O, 1/l/I) — ela é digitada à mão do email para a tela de troca.
 */
export function tempPassword(length = TEMP_PASSWORD_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i++) out += TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)];
  return out;
}

// ---------- email ----------

/** Normaliza para comparação/armazenamento: aparado e minúsculo. `null` quando vazio. */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  const trimmed = String(email).trim();
  return trimmed.length === 0 ? null : trimmed.toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validação de forma do email — a MESMA régua do módulo de equipe. */
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

// ---------- senha ----------

/**
 * Política mínima: 8..128 caracteres. Fora disso o erro é `password_too_short`
 * (400) com mensagem amigável — a tela de troca de senha exibe `message`.
 */
export function assertPasswordPolicy(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw Errors.passwordTooShort(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH);
  }
}
