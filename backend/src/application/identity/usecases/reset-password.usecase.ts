/**
 * `POST /auth/password/reset` — troca a senha pelo token do email (§4).
 *
 * O token é de uso ÚNICO: a linha é "reivindicada" (`claimPasswordResetUsage`,
 * UPDATE condicional `used_at IS NULL`) na MESMA transação que grava a senha —
 * dois cliques no link não trocam a senha duas vezes. Inválido, expirado ou já
 * usado → 400 `password_token_invalid` (mesmo erro nos três casos: o cliente não
 * precisa saber qual).
 *
 * A troca derruba TODAS as sessões da conta: quem tinha a senha antiga (ou o
 * refresh dela) sai.
 */
import argon2 from "argon2";
import { Errors } from "../../../domain/errors.js";
import type { IdentityDependencies } from "../ports/identity-dependencies.js";
import { assertPasswordPolicy, isPast, nowIso, sha256Hex } from "../identity-helpers.js";

export function createResetPasswordUsecase(deps: IdentityDependencies) {
  async function resetPassword(input: { token: string; newPassword: string }) {
    assertPasswordPolicy(input.newPassword);

    const tenant = deps.tenant();
    const now = nowIso();
    const tokenHash = sha256Hex(String(input.token ?? "").trim());
    const passwordHash = await argon2.hash(input.newPassword);

    await deps.uow.run(tenant, async (session) => {
      const reset = await session.identity.findPasswordResetByHash(tokenHash);
      if (!reset || reset.usedAt || isPast(reset.expiresAt, now)) throw Errors.passwordTokenInvalid();

      const claimed = await session.identity.claimPasswordResetUsage(reset.id, now);
      if (!claimed) throw Errors.passwordTokenInvalid();

      await session.identity.setAccountPassword(reset.accountId, {
        passwordHash,
        mustChangePassword: false,
        now,
      });
      await session.identity.revokeAllAuthSessions(reset.accountId, now);
    });

    return { ok: true as const };
  }

  return { resetPassword };
}

export type ResetPasswordUsecase = ReturnType<typeof createResetPasswordUsecase>;
