/**
 * Helpers puros do módulo de equipe (usuários): URL de foto, nomes de arquivo
 * seguros, serialização e normalizações.
 *
 * `photoUrl`/`isSafeFilename`/`storageFilename` são funções PURAS (eram de
 * `infra/storage`, sem I/O). Replicadas aqui para a application não importar a
 * camada de armazenamento — o `FileStorage` port (put/remove) é a única seam
 * de I/O (mesmo desenho de `customer.usecases`).
 */
import { Errors } from "../../../domain/errors.js";
import type { TenantSession } from "../../ports/unit-of-work.js";
import type { UserRecord } from "../../ports/repositories.js";

export type UserRole = "waiter" | "kitchen" | "manager" | "courier" | "cashier";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const UPLOADS_PREFIX = "/uploads";

/** Domínios de foto cujo caminho público é `/uploads/<kind>/<filename>`. */
type PhotoKind = "product" | "logo" | "customer" | "user";

/**
 * O banco guarda só o nome do arquivo; quem consome a API precisa do caminho
 * público. Fonte única do prefixo — a foto é servida em `/uploads/` sem auth
 * (o mesmo argumento das fotos de produto), então isso vale inclusive para as
 * rotas públicas do login.
 *
 * O `kind` é explícito porque `user.photo_path` e `customer.photo_path` são
 * colunas diferentes apontando para o mesmo formato: `/uploads/<kind>/<arquivo>`.
 */
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

// ---------- serialização / normalizações (mesmas do módulo original) ----------

export function serializeUser(u: UserRecord) {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    active: u.active,
    phone: u.phone ?? null,
    email: u.email ?? null,
    photoPath: photoUrl(u.photoPath, "user"),
    createdAt: u.createdAt,
  };
}

export function randomPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim() ?? "";
  if (!trimmed) return null;
  if (!EMAIL_RE.test(trimmed)) throw Errors.validationFailed({ field: "email" });
  return trimmed.toLowerCase();
}

export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length < 10 || digits.length > 11) throw Errors.validationFailed({ field: "phone" });
  return digits;
}

export async function assertEmailAvailable(
  session: TenantSession,
  email: string | null | undefined,
  exceptUserId?: string,
) {
  if (!email) return;
  const clash = await session.users.findByEmail(email);
  if (clash && clash.id !== exceptUserId) throw Errors.validationFailed({ field: "email", reason: "email já cadastrado" });
}
