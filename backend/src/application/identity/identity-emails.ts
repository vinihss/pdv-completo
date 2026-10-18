/**
 * Templates de email da identidade (convite e recuperação de senha).
 *
 * Puros: recebem os dados já resolvidos (nome da loja, link, senha temporária) e
 * devolvem `{subject, html, text}` para o port `Mailer`. A senha temporária SÓ
 * existe aqui e no corpo do email — nunca volta na resposta da API (decisão 9).
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface InviteEmailInput {
  storeName: string;
  userName: string;
  loginUrl: string;
  tempPassword: string;
}

export function inviteEmail(input: InviteEmailInput): { subject: string; html: string; text: string } {
  const store = escapeHtml(input.storeName);
  const name = escapeHtml(input.userName);
  const url = escapeHtml(input.loginUrl);
  const password = escapeHtml(input.tempPassword);
  return {
    subject: `Seu acesso ao ${input.storeName}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111">
        <p>Olá, ${name}!</p>
        <p>Você foi convidado(a) para usar o sistema do <strong>${store}</strong>.</p>
        <p>Entre em <a href="${url}">${url}</a> com o seu e-mail e esta senha temporária:</p>
        <p style="font-size:20px;font-weight:bold;letter-spacing:1px;padding:10px 14px;background:#f4f4f5;border-radius:8px;display:inline-block">${password}</p>
        <p>No primeiro acesso o sistema vai pedir para você criar uma senha própria.</p>
        <p>Se você não esperava este convite, ignore este email.</p>
      </div>
    `,
    text: [
      `Olá, ${input.userName}!`,
      `Você foi convidado(a) para usar o sistema do ${input.storeName}.`,
      `Entre em ${input.loginUrl} com o seu e-mail e esta senha temporária: ${input.tempPassword}`,
      "No primeiro acesso o sistema vai pedir para você criar uma senha própria.",
    ].join("\n"),
  };
}

export interface ResetEmailInput {
  resetUrl: string;
  /** Minutos de validade, só para o texto. */
  minutes: number;
}

export function passwordResetEmail(input: ResetEmailInput): { subject: string; html: string; text: string } {
  const url = escapeHtml(input.resetUrl);
  return {
    subject: "Redefinição de senha",
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111">
        <p>Recebemos um pedido para redefinir a senha da sua conta.</p>
        <p><a href="${url}">Criar uma nova senha</a></p>
        <p>O link vale por ${input.minutes} minutos e só pode ser usado uma vez.</p>
        <p>Se não foi você, ignore este email — a sua senha continua a mesma.</p>
      </div>
    `,
    text: [
      "Recebemos um pedido para redefinir a senha da sua conta.",
      `Criar uma nova senha: ${input.resetUrl}`,
      `O link vale por ${input.minutes} minutos e só pode ser usado uma vez.`,
    ].join("\n"),
  };
}
