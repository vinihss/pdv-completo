import type { Mailer, MailerSendInput, MailerSendResult } from "../../application/ports/effects.js";
import { getMailer, type MailerTransport } from "./mailer.js";

/**
 * Adapter do port `Mailer` (ports/effects.ts) — FASE 0.
 *
 * Os tipos do port (`MailerSendInput`/`MailerSendResult`) são os mesmos de
 * `mailer.ts`: o adapter é uma ponte de tipagem pura, sem tradução de campos.
 *
 * A injeção é opcional de propósito: quando o transport não é injetado, a
 * resolução é `getMailer()` POR ENVIO — é isso que mantém vivo o seam
 * `setMailerForTests` (a suite injeta o fake e o adapter o enxerga, mesmo
 * tendo sido construído antes). Comportamento idêntico ao `sendEmail`
 * atual, inclusive `{ sent: false, reason: "not_configured" }` sem SMTP_HOST.
 */
export class MailerPortAdapter implements Mailer {
  constructor(private readonly transport?: MailerTransport) {}

  async send(input: MailerSendInput): Promise<MailerSendResult> {
    return (this.transport ?? getMailer()).send(input);
  }
}
