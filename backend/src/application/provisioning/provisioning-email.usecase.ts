import QRCode from "qrcode";
import { Errors } from "../../domain/errors.js";
import type { Mailer } from "../ports/effects.js";
import type { TenantContext } from "../ports/tenant-context.js";
import type { TenantUnitOfWork } from "../ports/unit-of-work.js";

/**
 * Envio do email de provisionamento para o usuário (docs/21 §5.1/§7).
 *
 * O envio materializa uma nova chave (gira a anterior) e devolve o
 * resultado ao gerente: `{sent, reason?, keyId, code, expiresAt}`.
 * Falhas de SMTP não desfazem a geração da chave — o gerente vê o
 * `sent:false` e pode reenviar.
 *
 * Migrado para ports + UoW: o usuário é lido pela `session.users`, a chave é
 * gerada pelo use case injetado (o mesmo `generateProvisioningKeyUsecase`, que
 * roda a própria janela transacional) e o envio sai pelo port `Mailer`. O
 * HTML/QR é renderizado AQUI (a `application` conhece o layout do email; o
 * adapter de SMTP só transporta).
 */

/** Formato do retorno de `generateProvisioningKeyUsecase` (o único contrato que importa aqui). */
interface GeneratedProvisioningKey {
  keyId: string;
  code: string;
  qrPayload: string;
  expiresAt: string | null;
  hint: string;
}

export interface ProvisioningEmailUsecasesDeps {
  uow: TenantUnitOfWork;
  tenant: () => TenantContext;
  mailer: Mailer;
  /**
   * Injetado: o composition root liga ao `generateProvisioningKeyUsecase`. O
   * envio materializa uma chave nova — daí a dependência, e não um import
   * cruzado entre use cases.
   */
  generateProvisioningKey: (input: {
    userId: string;
    createdBy: string;
    expiresAt?: string | null;
  }) => Promise<GeneratedProvisioningKey>;
}

export function createProvisioningEmailUsecases(deps: ProvisioningEmailUsecasesDeps) {
  /**
   * Envia o email de provisionamento para o usuário (docs/21 §5.1).
   *
   * O envio materializa uma nova chave (gira a anterior) e devolve o
   * resultado ao gerente: `{sent, reason?, keyId, code, expiresAt}`.
   * Falhas de SMTP não desfazem a geração da chave — o gerente vê o
   * `sent:false` e pode reenviar.
   */
  async function sendProvisioningEmailUsecase(input: {
    userId: string;
    actorId: string;
    downloadLinks?: { android?: string; ios?: string; web?: string };
  }) {
    const user = await deps.uow.run(deps.tenant(), async (session) => {
      const u = await session.users.findById(input.userId);
      if (!u) throw Errors.notFound("Usuário");
      if (!u.email) throw Errors.validationFailed({ field: "email", reason: "usuário sem email" });
      return { id: u.id, name: u.name, email: u.email };
    });

    const key = await deps.generateProvisioningKey({
      userId: user.id,
      createdBy: input.actorId,
    });

    const emailResult = await sendProvisioningEmail(deps.mailer, {
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
  async function resendProvisioningEmailUsecase(input: {
    userId: string;
    actorId: string;
    downloadLinks?: { android?: string; ios?: string; web?: string };
  }) {
    return sendProvisioningEmailUsecase(input);
  }

  return { sendProvisioningEmailUsecase, resendProvisioningEmailUsecase };
}

// ---------------------------------------------------------------------------
// Render do email (docs/21 §7): código legível + QR inline (cid).
// ---------------------------------------------------------------------------

interface ProvisioningEmailInput {
  to: string;
  userName: string;
  codeDisplay: string; // ex: "PDV-ABCD-EFGH-IJKL-MNOP"
  qrPayload: string; // ex: "PDVPROV1:PDV-ABCD-EFGH-IJKL-MNOP"
  pin?: string | null;
  downloadLinks?: {
    android?: string;
    ios?: string;
    web?: string;
  };
}

async function sendProvisioningEmail(mailer: Mailer, input: ProvisioningEmailInput) {
  const qrPng = await QRCode.toBuffer(input.qrPayload, { width: 280, margin: 1 });
  const html = renderProvisioningHtml(input);

  return mailer.send({
    to: input.to,
    subject: "Seu app PDV está pronto — provisionamento",
    html,
    text: renderProvisioningText(input),
    attachments: [
      {
        filename: "provisioning-qrcode.png",
        content: qrPng,
        contentType: "image/png",
        cid: "provisioning-qrcode",
      },
    ],
  });
}

function renderProvisioningHtml(input: ProvisioningEmailInput): string {
  const pinBlock = input.pin
    ? `<p style="margin:16px 0;padding:12px;background:#fff3cd;border-radius:6px">
         <strong>Seu PIN:</strong> <code style="font-size:1.2em">${input.pin}</code>
         <br><small>Não compartilhe este código.</small>
       </p>`
    : "";

  const linksBlock = input.downloadLinks
    ? Object.entries(input.downloadLinks)
        .filter(([, url]) => url)
        .map(([platform, url]) => `<li><a href="${url}">${platformLabel(platform)}</a></li>`)
        .join("")
    : "";

  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h1 style="margin:0 0 16px;font-size:1.4em">Olá, ${input.userName}</h1>
      <p>Seu acesso ao PDV está pronto. Instale o app no seu aparelho e faça o provisionamento com o código abaixo:</p>
      <p style="margin:16px 0;padding:12px;background:#f4f4f5;border-radius:6px;text-align:center">
        <code style="font-size:1.3em;letter-spacing:1px">${input.codeDisplay}</code>
      </p>
      <p style="text-align:center"><img src="cid:provisioning-qrcode" alt="QR Code de provisionamento" style="width:220px;height:220px"></p>
      ${pinBlock}
      ${linksBlock ? `<h3>Download do app</h3><ul>${linksBlock}</ul>` : ""}
      <p style="color:#71717a;font-size:.85em;margin-top:32px">
        Se você não esperava este email, ignore-o — a chave só ativa um aparelho deste usuário.
      </p>
    </div>
  `;
}

function renderProvisioningText(input: ProvisioningEmailInput): string {
  const lines = [
    `Olá, ${input.userName}`,
    "",
    "Seu acesso ao PDV está pronto.",
    `Código de provisionamento: ${input.codeDisplay}`,
  ];
  if (input.pin) lines.push(`PIN: ${input.pin}`);
  if (input.downloadLinks) {
    lines.push("", "Download do app:");
    for (const [platform, url] of Object.entries(input.downloadLinks)) {
      if (url) lines.push(`  ${platformLabel(platform)}: ${url}`);
    }
  }
  return lines.join("\n");
}

function platformLabel(platform: string): string {
  switch (platform) {
    case "android": return "Android";
    case "ios": return "iOS";
    case "web": return "Versão web";
    default: return platform;
  }
}
