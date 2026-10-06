import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { users } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { config } from "../../config/env.js";
import { photoUrl } from "../user.usecases.js";
import { assertDeviceForLogin } from "../provisioning/provisioning.usecases.js";

const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60_000;

/**
 * Contabiliza uma tentativa de login errada (incrementa `failedAttempts` e
 * trava a conta em `MAX_ATTEMPTS`).
 */
async function countFailedAttempt(u: Pick<typeof users.$inferSelect, "id" | "failedAttempts">) {
  const attempts = u.failedAttempts + 1;
  const shouldLock = attempts >= MAX_ATTEMPTS;
  await db
    .update(users)
    .set({
      failedAttempts: attempts,
      lockedUntil: shouldLock ? new Date(Date.now() + LOCK_MS).toISOString() : null,
    })
    .where(eq(users.id, u.id));
}

/** Autentica um usuário por PIN. `deviceId` opcional (docs/21 §5.3/§6): quando
 * presente, o aparelho precisa ser conhecido, ativo, não revogado e vinculado
 * ao `userId`; sem ele, comportamento inalterado (PWA/tablet compartilhado). */
export async function loginUsecase(userId: string, rawPin: string, deviceId?: string) {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!u || !u.active) throw Errors.invalidCredentials();

  if (u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now()) {
    throw Errors.invalidCredentials(); // mensagem genérica de propósito — não vaza motivo do bloqueio
  }

  const valid = await argon2.verify(u.pinHash, rawPin);
  if (!valid) {
    await countFailedAttempt(u);
    throw Errors.invalidCredentials();
  }

  await db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, userId));

  if (deviceId) await assertDeviceForLogin(userId, deviceId);

  const token = jwt.sign({ sub: u.id, role: u.role }, config.jwtSecret, { expiresIn: "12h" });
  // A foto vai na sessão (não no JWT) para a identidade do app logado mostrar
  // o avatar sem uma segunda chamada.
  return { token, user: { id: u.id, name: u.name, role: u.role, photoPath: photoUrl(u.photoPath, "user") } };
}
