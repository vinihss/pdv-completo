/**
 * Helpers puros do módulo de clientes: URL de foto, nomes de arquivo seguros,
 * normalizações de domínio, serialização e a janela do gráfico de consumo.
 *
 * `photoUrl`/`isSafeFilename`/`storageFilename` são funções PURAS (eram de
 * `infra/storage`, sem I/O). `photoUrl` replica o helper de
 * `user/shared/user-helpers.ts` (mesma família de foto de equipe). Mantêm a
 * MESMA lógica — o `FileStorage` port (put/remove) é a única seam de I/O.
 */
import { Errors } from "../../../domain/errors.js";
import type { TenantSession } from "../../ports/unit-of-work.js";
import type { CustomerRecord } from "../../ports/repositories.js";

/** `/uploads/<kind>/<filename>` — mesmo formato de `storageAssetPath`. */
const UPLOADS_PREFIX = "/uploads";
type PhotoKind = "product" | "logo" | "customer" | "user";
export function photoUrl(photoPath: string | null | undefined, kind: PhotoKind): string | null {
  return photoPath ? `${UPLOADS_PREFIX}/${kind}/${photoPath}` : null;
}

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
export function isSafeFilename(filename: string): boolean {
  if (!filename || filename.length > 200) return false;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) return false;
  if (filename === "." || filename === "..") return false;
  return FILENAME_RE.test(filename);
}

/** Normaliza o que está no banco para o nome de arquivo (só o basename). */
export function storageFilename(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.split(/[\\/]/).pop() ?? "";
  return name.length > 0 ? name : null;
}

// ---------- normalizações de domínio (mesmas do módulo original) ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim() ?? "";
  if (!trimmed) return null;
  if (!EMAIL_RE.test(trimmed)) throw Errors.validationFailed({ field: "email" });
  return trimmed.toLowerCase();
}

export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length < 8 || digits.length > 15) throw Errors.validationFailed({ field: "phone" });
  return digits;
}

// Observação é texto livre: o limite é o que o banco aceita. Só o vazio é
// normalizado para null, para "limpar o campo" e "nunca preencher" não
// virarem dois estados diferentes na mesma coluna.
export function normalizeNotes(notes: string | null | undefined): string | null {
  const trimmed = (notes ?? "").trim();
  return trimmed ? trimmed : null;
}

/**
 * Fonte única do shape de cliente, usada pela lista, pelo detalhe, pelo create
 * e pelo update. `cpf`/`notes`/`photoPath` (migration 0008) entram aqui em vez
 * de só no detalhe de propósito: são os mesmos papéis (gerente/caixa) em todas
 * essas rotas, e um campo que aparece no PATCH mas não na lista faria o
 * frontend decidir "devo reler o GET?" depois de salvar. A busca do garçom
 * (`searchCustomersUsecase`) NÃO usa este serialize — é a superfície mínima
 * do balcão e não muda.
 */
export function serializeCustomer(c: CustomerRecord, addressCount = 0) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone ?? null,
    email: c.email ?? null,
    // CPF cru (11 dígitos, sem máscara) e `photoPath` já no caminho público —
    // quem consome a API não monta `/uploads/...` por conta própria.
    cpf: c.cpf ?? null,
    notes: c.notes ?? null,
    photoPath: photoUrl(c.photoPath, "customer"),
    active: c.active,
    addressCount,
    createdAt: c.createdAt,
  };
}

export async function assertEmailAvailable(
  session: TenantSession,
  email: string | null | undefined,
  exceptCustomerId?: string,
) {
  if (!email) return;
  const clash = await session.customers.findByEmail(email);
  if (clash && clash.id !== exceptCustomerId) throw Errors.validationFailed({ field: "email", reason: "email já cadastrado" });
}

/**
 * CPF único entre clientes — mesma forma do email: `400 validation_failed` com
 * `{ field: "cpf" }`, e o `uq_customer_cpf` (migration 0008) como segunda
 * linha de defesa para a corrida em que dois requests passam pelo check juntos.
 */
export async function assertCpfAvailable(
  session: TenantSession,
  cpf: string | null | undefined,
  exceptCustomerId?: string,
) {
  if (!cpf) return;
  const clash = await session.customers.findByCpf(cpf);
  if (clash && clash.id !== exceptCustomerId) throw Errors.validationFailed({ field: "cpf", reason: "CPF já cadastrado" });
}

// ---------- constantes e helpers do summary (mesmos do módulo original) ----------

export const DEFAULT_SUMMARY_DAYS = 30;
export const MAX_SUMMARY_DAYS = 365;

// Janela do gráfico. O clamp é aqui (e não na rota) porque o valor também vem
// de link/URL: 0 dias ou 40000 dias dariam uma série inútil (ou um relatório
// varrendo a base) em vez de um erro, e quem decide o teto é o domínio.
export function normalizeDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return DEFAULT_SUMMARY_DAYS;
  return Math.min(MAX_SUMMARY_DAYS, Math.max(1, Math.trunc(days)));
}
