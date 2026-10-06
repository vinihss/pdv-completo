import QRCode from "qrcode";
import { sendEmail } from "./mailer.js";

/**
 * Email de provisionamento (docs/21 §7).
 *
 * Conteúdo: instruções de download, código legível + QR inline (cid),
 * e o PIN quando estiver disponível (criação/reset-pin). O envio é
 * sempre pós-commit: falha não desfaz a geração da chave — apenas
 * retorna `{sent:false}` ao gerente.
 */

export interface ProvisioningEmailInput {
  to: string;
  userName: string;
  codeDisplay: string; // ex: "PDV-ABCD-EFGH-IJKL-MNOP"
  qrPayload: string;   // ex: "PDVPROV1:PDV-ABCD-EFGH-IJKL-MNOP"
  pin?: string | null;
  downloadLinks?: {
    android?: string;
    ios?: string;
    web?: string;
  };
}

export async function sendProvisioningEmail(input: ProvisioningEmailInput) {
  const qrPng = await QRCode.toBuffer(input.qrPayload, { width: 280, margin: 1 });
  const html = renderProvisioningHtml(input);

  return sendEmail({
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
