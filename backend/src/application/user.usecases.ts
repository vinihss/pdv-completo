import { eq } from "drizzle-orm";
import argon2 from "argon2";
import { db } from "../infra/db/client.js";
import { users } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";
import { logAction } from "../infra/audit-log.js";
import {
  getStorage,
  isSafeFilename,
  storageAssetPath,
  storageFilename,
  type StorageKind,
} from "../infra/storage/index.js";

const storage = getStorage();

export type UserRole = "waiter" | "kitchen" | "manager" | "courier" | "cashier";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * O banco guarda só o nome do arquivo; quem consome a API precisa do caminho
 * público. Fonte única do prefixo — a foto é servida em `/uploads/` sem auth
 * (o mesmo argumento das fotos de produto), então isso vale inclusive para as
 * rotas públicas do login.
 *
 * O `kind` é explícito porque `user.photo_path` e `customer.photo_path` são
 * colunas diferentes apontando para o mesmo formato: `/uploads/<kind>/<arquivo>`.
 */
export function photoUrl(photoPath: string | null | undefined, kind: StorageKind): string | null {
  return photoPath ? storageAssetPath(kind, photoPath) : null;
}

function serialize(u: typeof users.$inferSelect) {
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

export async function listUsersUsecase() {
  const rows = await db.query.users.findMany({ orderBy: (u, { asc }) => asc(u.name) });
  return rows.map(serialize);
}

function randomPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim() ?? "";
  if (!trimmed) return null;
  if (!EMAIL_RE.test(trimmed)) throw Errors.validationFailed({ field: "email" });
  return trimmed.toLowerCase();
}

function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length < 10 || digits.length > 11) throw Errors.validationFailed({ field: "phone" });
  return digits;
}

async function assertEmailAvailable(email: string | null | undefined, exceptUserId?: string) {
  if (!email) return;
  const clash = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (clash && clash.id !== exceptUserId) throw Errors.validationFailed({ field: "email", reason: "email já cadastrado" });
}

export async function createUserUsecase(input: {
  name: string;
  role: UserRole;
  phone?: string | null;
  email?: string | null;
}) {
  const email = normalizeEmail(input.email);
  await assertEmailAvailable(email);
  const phoneDigits = normalizePhone(input.phone);
  const pin = randomPin();
  const pinHash = await argon2.hash(pin);
  const [created] = await db
    .insert(users)
    .values({ name: input.name, role: input.role, pinHash, phone: phoneDigits, email })
    .returning();
  return { ...serialize(created), pin }; // PIN retornado uma única vez, em texto puro, pra exibição ao gerente
}

export async function updateUserUsecase(
  id: string,
  input: {
    name?: string;
    role?: UserRole;
    active?: boolean;
    phone?: string | null;
    email?: string | null;
    pin?: string;
  }
) {
  const existing = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!existing) throw Errors.notFound("Usuário");

  const email = input.email !== undefined ? normalizeEmail(input.email) : undefined;
  if (input.email !== undefined) await assertEmailAvailable(email, id);
  const phoneDigits = input.phone !== undefined ? normalizePhone(input.phone) : undefined;

  // PIN manual (4-6 dígitos): mesma regra do reset-pin — troca o hash e
  // desbloqueia a conta. O reset-pin continua existindo para gerar um PIN
  // aleatório.
  let pinHash = existing.pinHash;
  let failedAttempts = existing.failedAttempts;
  let lockedUntil = existing.lockedUntil;
  if (input.pin !== undefined) {
    const digits = input.pin.replace(/\D/g, "");
    if (digits.length < 4 || digits.length > 6) throw Errors.validationFailed({ field: "pin" });
    pinHash = await argon2.hash(digits);
    failedAttempts = 0;
    lockedUntil = null;
  }

  const [updated] = await db
    .update(users)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(phoneDigits !== undefined ? { phone: phoneDigits } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(pinHash !== existing.pinHash ? { pinHash, failedAttempts, lockedUntil } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(users.id, id))
    .returning();
  return serialize(updated);
}

export async function resetPinUsecase(id: string) {
  const existing = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!existing) throw Errors.notFound("Usuário");
  const pin = randomPin();
  const pinHash = await argon2.hash(pin);
  await db
    .update(users)
    .set({ pinHash, failedAttempts: 0, lockedUntil: null, updatedAt: new Date().toISOString() })
    .where(eq(users.id, id));
  return { pin }; // exibido uma única vez ao gerente
}

// ---------- Foto (upload em disco, caminho gravado em user.photo_path) ----------
//
// Mesmo desenho de `customer.usecases.ts` e `product.usecases.ts`: nome de
// arquivo GERADO pelo app a partir do id (o nome enviado pelo cliente nunca
// vira caminho), arquivo antigo removido quando a extensão muda, e o
// `logAction` na mesma transação do UPDATE. O caminho em disco é montado pelo
// `storage` (infra/storage), com o diretório do tenant.

export async function saveUserPhotoUsecase(id: string, input: { buffer: Buffer; ext: string }, actorId: string) {
  const existing = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!existing) throw Errors.notFound("Usuário");

  const filename = `${id}.${input.ext}`;
  if (!isSafeFilename(filename)) throw Errors.validationFailed({ field: "photo" });
  await storage.put("user", filename, input.buffer);

  const previous = storageFilename(existing.photoPath);
  if (previous && previous !== filename) await storage.remove("user", previous);

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ photoPath: filename, updatedAt: new Date().toISOString() })
      .where(eq(users.id, id))
      .returning();
    await logAction(tx, actorId, "user_photo_changed", null, { userId: id });
    return row;
  });
  return serialize(updated);
}

export async function clearUserPhotoUsecase(id: string, actorId: string) {
  const existing = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!existing) throw Errors.notFound("Usuário");
  const previous = storageFilename(existing.photoPath);
  if (previous) await storage.remove("user", previous);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ photoPath: null, updatedAt: new Date().toISOString() })
      .where(eq(users.id, id))
      .returning();
    await logAction(tx, actorId, "user_photo_removed", null, { userId: id });
    return row;
  });
  return serialize(updated);
}
