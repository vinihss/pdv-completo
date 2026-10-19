/**
 * `POST /auth/password/change` — troca (normalmente OBRIGATÓRIA) da senha (§4).
 *
 * Autorizado só pelo `accountToken` (10min): quem acabou de entrar com a senha
 * temporária não tem, ainda, sessão de loja nenhuma. Ao trocar, o módulo derruba
 * as sessões de refresh e invalida os pedidos de recuperação pendentes — a senha
 * antiga (a temporária que chegou por email) deixa de valer em qualquer
 * dispositivo, e nenhum token de recuperação emitido antes continua utilizável.
 */
import argon2 from "argon2";
import { Errors } from "../../../domain/errors.js";
import type { IdentityDependencies } from "../ports/identity-dependencies.js";
import { assertPasswordPolicy, nowIso } from "../identity-helpers.js";

export function createChangePasswordUsecase(deps: IdentityDependencies) {
  async function changePassword(input: { accountId: string; newPassword: string }) {
    assertPasswordPolicy(input.newPassword);

    const tenant = deps.tenant();
    const account = await deps.uow.run(tenant, (session) => session.identity.findAccountById(input.accountId));
    if (!account || account.status !== "active") {
      throw Errors.unauthorized("Conta não encontrada ou suspensa.");
    }

    const passwordHash = await argon2.hash(input.newPassword);
    const now = nowIso();
    await deps.uow.run(tenant, async (session) => {
      await session.identity.setAccountPassword(account.id, {
        passwordHash,
        mustChangePassword: false,
        now,
      });
      await session.identity.revokeAllAuthSessions(account.id, now);
      await session.identity.invalidatePendingPasswordResets(account.id, now);
    });

    return { ok: true as const };
  }

  return { changePassword };
}

export type ChangePasswordUsecase = ReturnType<typeof createChangePasswordUsecase>;
