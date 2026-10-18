/**
 * `POST /auth/password/forgot` — link de recuperação por email (§4).
 *
 * Anti-enumeração dos dois lados:
 * 1. a checagem de SMTP acontece ANTES de qualquer consulta — sem email
 *    configurado TODO pedido devolve o mesmo `503 email_not_configured`, exista
 *    ou não a conta;
 * 2. com SMTP, conta desconhecida/suspensa também devolve 202 e nada é gravado
 *    nem enviado (mesma latência de resposta).
 *
 * O link é montado pela ROTA (que conhece o host/origem do request) e chega aqui
 * pronto em `origin` — a application não lê `req` nem `config` (§ do
 * `docs/agent-backend.md`: a application fala ports).
 */
import { Errors } from "../../../domain/errors.js";
import type { IdentityDependencies } from "../ports/identity-dependencies.js";
import { passwordResetEmail } from "../identity-emails.js";
import { PASSWORD_RESET_TTL_MS, addMs, newId, nowIso, normalizeEmail, opaqueToken, sha256Hex } from "../identity-helpers.js";

const RESET_TTL_MINUTES = Math.round(PASSWORD_RESET_TTL_MS / 60000);

export function createForgotPasswordUsecase(deps: IdentityDependencies) {
  async function forgotPassword(input: { email: string; origin: string }) {
    if (!deps.mailer.isConfigured()) throw Errors.emailNotConfigured();

    const email = normalizeEmail(input.email);
    const account = email
      ? await deps.uow.run(deps.tenant(), (session) => session.identity.findAccountByEmail(email))
      : null;
    if (!account || account.status !== "active") return { ok: true as const, delivered: false };

    const now = nowIso();
    const token = opaqueToken();
    await deps.uow.run(deps.tenant(), async (session) => {
      // Um pedido novo invalida os anteriores: só o último link vale.
      await session.identity.invalidatePendingPasswordResets(account.id, now);
      await session.identity.createPasswordReset({
        id: newId(),
        accountId: account.id,
        tokenHash: sha256Hex(token),
        expiresAt: addMs(now, PASSWORD_RESET_TTL_MS),
        now,
      });
    });

    const resetUrl = `${input.origin}/reset-password?token=${encodeURIComponent(token)}`;
    const body = passwordResetEmail({ resetUrl, minutes: RESET_TTL_MINUTES });
    const result = await deps.mailer.send({
      to: account.email,
      subject: body.subject,
      html: body.html,
      text: body.text,
    });
    if (!result.sent) {
      // Falha transitória de SMTP não muda a resposta (não enumerar) — a conta
      // pode pedir de novo; o token gravado expira sozinho em 30min.
      console.error(`[identity] falha ao enviar recuperação de senha: ${result.reason ?? "erro"}`);
    }
    return { ok: true as const, delivered: result.sent };
  }

  return { forgotPassword };
}

export type ForgotPasswordUsecase = ReturnType<typeof createForgotPasswordUsecase>;
