import nodemailer from "nodemailer";
import { config } from "../../config/env.js";

/**
 * Mailer genérico via SMTP (docs/21 §7).
 *
 * Sem SMTP_HOST configurado, o transporte não é inicializado e
 * `sendEmail` reporta `{sent:false, reason:"not_configured"}` — a
 * criação de usuário/chave não quebra, só não sai o email. O seam
 * `setMailerForTests` permite que a suite de testes injete um fake
 * sem tocar na rede.
 */

export interface MailerSendInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string; cid?: string }>;
}

export interface MailerSendResult {
  sent: boolean;
  reason?: "not_configured" | "error";
  messageId?: string;
  error?: string;
}

export interface MailerTransport {
  send(input: MailerSendInput): Promise<MailerSendResult>;
}

class SmtpMailer implements MailerTransport {
  private transporter: nodemailer.Transporter | null = null;

  private getTransporter(): nodemailer.Transporter | null {
    if (this.transporter) return this.transporter;
    if (!config.smtpHost) return null;
    this.transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth:
        config.smtpUser && config.smtpPass
          ? { user: config.smtpUser, pass: config.smtpPass }
          : undefined,
    });
    return this.transporter;
  }

  async send(input: MailerSendInput): Promise<MailerSendResult> {
    const t = this.getTransporter();
    if (!t) return { sent: false, reason: "not_configured" };
    try {
      const info = await t.sendMail({
        from: config.mailFrom,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        attachments: input.attachments as any,
      });
      return { sent: true, messageId: info.messageId };
    } catch (err: any) {
      return { sent: false, reason: "error", error: String(err?.message ?? err) };
    }
  }
}

let activeMailer: MailerTransport = new SmtpMailer();

/** Usado pelos testes para injetar um mailer fake (sem rede). */
export function setMailerForTests(m: MailerTransport) {
  activeMailer = m;
}

export function getMailer(): MailerTransport {
  return activeMailer;
}

export async function sendEmail(input: MailerSendInput): Promise<MailerSendResult> {
  return activeMailer.send(input);
}
