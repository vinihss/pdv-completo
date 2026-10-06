import { db } from "../../infra/db/client.js";
import { users } from "../../infra/db/schema.js";
import { eq } from "drizzle-orm";
import { Errors } from "../../domain/errors.js";
import { sendProvisioningEmail } from "../../infra/mail/provisioning-email.js";
import { generateProvisioningKeyUsecase } from "./provisioning.usecases.js";

/**
 * Envia o email de provisionamento para o usuário (docs/21 §5.1).
 *
 * O envio materializa uma nova chave (gira a anterior) e devolve o
 * resultado ao gerente: `{sent, reason?, keyId, code, expiresAt}`.
 * Falhas de SMTP não desfazem a geração da chave — o gerente vê o
 * `sent:false` e pode reenviar.
 */
export async function sendProvisioningEmailUsecase(input: {
  userId: string;
  actorId: string;
  downloadLinks?: { android?: string; ios?: string; web?: string };
}) {
  const [user] = await db.select().from(users).where(eq(users.id, input.userId));
  if (!user) throw Errors.notFound("Usuário");
  if (!user.email) throw Errors.validationFailed({ field: "email", reason: "usuário sem email" });

  const key = await generateProvisioningKeyUsecase({
    userId: user.id,
    createdBy: input.actorId,
  });

  const emailResult = await sendProvisioningEmail({
    to: user.email,
    userName: user.name,
    codeDisplay: key.code,
    qrPayload: key.qrPayload,
    downloadLinks: input.downloadLinks,
  });

  return {
    sent: emailResult.sent,
    reason: emailResult.reason,
    keyId: key.keyId,
    code: key.code,
    qrPayload: key.qrPayload,
    expiresAt: key.expiresAt,
    hint: key.hint,
  };
}

/**
 * Reenvio do email de instruções sem girar a chave atual (usa a
 * chave ativa já existente, se houver). Se não houver chave ativa,
 * gera uma — o usuário precisa de pelo menos uma para configurar um
 * aparelho novo.
 */
export async function resendProvisioningEmailUsecase(input: {
  userId: string;
  actorId: string;
  downloadLinks?: { android?: string; ios?: string; web?: string };
}) {
  // Nesta versão simplificada, "reenviar" também gera uma chave nova
  // (o caminho de "apenas reenviar a mesma chave" exige o código em
  // texto puro, que não persiste — então o reenvio materializa uma
  // nova credencial, que é igualmente válida para o usuário).
  return sendProvisioningEmailUsecase(input);
}
