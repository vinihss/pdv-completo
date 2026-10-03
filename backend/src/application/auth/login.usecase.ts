import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { stores, users } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { config } from "../../config/env.js";
import { photoUrl } from "../user.usecases.js";

const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60_000;

export async function loginUsecase(userId: string, rawPin: string) {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!u || !u.active) throw Errors.invalidCredentials();

  if (u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now()) {
    throw Errors.invalidCredentials(); // mensagem genérica de propósito — não vaza motivo do bloqueio
  }

  const valid = await argon2.verify(u.pinHash, rawPin);
  if (!valid) {
    const attempts = u.failedAttempts + 1;
    const shouldLock = attempts >= MAX_ATTEMPTS;
    await db
      .update(users)
      .set({
        failedAttempts: attempts,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCK_MS).toISOString() : null,
      })
      .where(eq(users.id, userId));
    throw Errors.invalidCredentials();
  }

  await db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, userId));

  // Multi-tenant: embute a store do usuário no JWT. Enquanto o usuário
  // estiver logado, o header Authorization substitui o Host na resolução do
  // tenant (ver tenant.middleware) — funciona também fora do domínio web
  // (desktop/mobile), que não têm subdomínio próprio.
  const store = u.storeId
    ? await db.query.stores.findFirst({ where: eq(stores.id, u.storeId) })
    : undefined;
  const token = jwt.sign(
    { sub: u.id, role: u.role, storeId: u.storeId ?? undefined, storeSlug: store?.slug },
    config.jwtSecret,
    { expiresIn: "12h" },
  );
  // A foto vai na sessão (não no JWT) para a identidade do app logado mostrar
  // o avatar sem uma segunda chamada.
  return { token, user: { id: u.id, name: u.name, role: u.role, photoPath: photoUrl(u.photoPath) } };
}
