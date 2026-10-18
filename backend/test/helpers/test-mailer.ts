/**
 * Mailer FAKE dos testes (seam `setMailerForTests`, infra/mail/mailer.ts).
 *
 * O `vitest.config.ts` não tem `setupFiles` — cada arquivo que exercita fluxo
 * com email (`POST /users`, `/auth/password/*`) instala o fake no seu próprio
 * `beforeAll`, senão o `SmtpMailer` real responderia `isConfigured() === false`
 * e o 503 `email_not_configured` apareceria no meio do teste.
 *
 * `sent` guarda o corpo dos emails: é de lá que os testes tiram o token de
 * recuperação (a API nunca devolve o token) e a senha temporária do convite.
 */
import {
  setMailerForTests,
  type MailerSendInput,
  type MailerSendResult,
  type MailerTransport,
} from "../../src/infra/mail/mailer.js";

export interface SentMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface TestMailer {
  /** Emails "enviados", em ordem. */
  sent: SentMail[];
  /** Liga/desliga o SMTP fake (para provar o 503 `email_not_configured`). */
  setConfigured(value: boolean): void;
  /** Esvazia a caixa (chamado no `beforeEach` dos testes). */
  reset(): void;
  /** Último email enviado (o mais recente é o que vale no fluxo). */
  last(): SentMail | undefined;
  /** Extrai o token do link de recuperação do último email. */
  lastResetToken(): string;
}

/** Instala o fake e devolve o handle. `configured: false` simula ausência de SMTP. */
export function installTestMailer(opts: { configured?: boolean } = {}): TestMailer {
  const sent: SentMail[] = [];
  let configured = opts.configured ?? true;

  const transport: MailerTransport = {
    isConfigured: () => configured,
    async send(input: MailerSendInput): Promise<MailerSendResult> {
      sent.push({
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text ?? "",
      });
      return { sent: true, messageId: `test-${sent.length}` };
    },
  };

  setMailerForTests(transport);

  return {
    sent,
    setConfigured: (value: boolean) => {
      configured = value;
    },
    reset: () => {
      sent.length = 0;
    },
    last: () => sent[sent.length - 1],
    lastResetToken: () => {
      const mail = sent[sent.length - 1];
      if (!mail) throw new Error("nenhum email enviado — não há token de recuperação");
      const match = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(mail.text);
      if (!match) throw new Error("email sem link de recuperação");
      return decodeURIComponent(match[1]);
    },
  };
}
