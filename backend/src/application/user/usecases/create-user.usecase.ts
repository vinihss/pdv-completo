/**
 * `POST /users` (manager): convida um usuário da equipe (docs/26 §4).
 *
 * Fluxo do convite (decisão 4):
 * 1. a conta GLOBAL é encontrada ou criada pelo email (`ensureAccount`, dormant);
 * 2. a senha da conta é ROTACIONADA para uma senha temporária nova de 10
 *    caracteres, com troca obrigatória no primeiro login;
 * 3. a linha `user` da loja (dona do `role`) é gravada apontando para a conta;
 * 4. o email com a senha temporária sai DENTRO da transação — se o envio falhar,
 *    o throw desfaz 1..3 ("nada é gravado", decisão 9).
 *
 * O barramento de SMTP é checado ANTES de abrir a transação: sem SMTP o 503
 * `email_not_configured` é imediato e não cria nem conta nem usuário.
 *
 * O PIN continua sendo gerado e devolvido UMA única vez (rota legada do app
 * desktop); a senha temporária NUNCA volta na resposta — ela só existe no email.
 */
import argon2 from "argon2";
import type { UserDependencies } from "../ports/user-dependencies.js";
import {
  assertEmailAvailable,
  normalizeEmail,
  normalizePhone,
  randomPin,
  serializeUser,
  type UserRole,
} from "../shared/user-helpers.js";
import { Errors } from "../../../domain/errors.js";
import { inviteEmail } from "../../identity/identity-emails.js";
import { newId, nowIso, tempPassword } from "../../identity/identity-helpers.js";

export type CreateUserInput = {
  name: string;
  role: UserRole;
  phone?: string | null;
  /** OBRIGATÓRIO no fluxo de identidade centralizada (docs/26 §4). */
  email: string;
  /**
   * Origem do app (ex.: `https://pdv.loja.com.br`) para montar o link do email.
   * Chega pronta da rota — a application não lê `req` nem `config`.
   */
  origin?: string;
};

export class CreateUserUseCase {
  constructor(private readonly deps: UserDependencies) {}

  async execute(input: CreateUserInput) {
    const email = normalizeEmail(input.email);
    if (!email) throw Errors.validationFailed({ field: "email" });
    const phoneDigits = normalizePhone(input.phone);
    const pin = randomPin();

    // Sem SMTP o convite é impossível: falha ANTES de tocar no banco.
    if (!this.deps.mailer.isConfigured()) throw Errors.emailNotConfigured();

    const pinHash = await argon2.hash(pin);
    const temporaryPassword = tempPassword();
    const passwordHash = await argon2.hash(temporaryPassword);

    const created = await this.deps.uow.run(this.deps.tenant(), async (session) => {
      await assertEmailAvailable(session, email);

      const now = nowIso();
      const account = await session.identity.ensureAccount({
        id: newId(),
        email,
        name: input.name,
        now,
      });
      // Convite ROTACIONA a senha: quem tinha credencial nesta conta global
      // recebe a temporária nova (e é obrigado a trocá-la no primeiro login).
      await session.identity.setAccountPassword(account.id, {
        passwordHash,
        mustChangePassword: true,
        now,
      });

      const row = await session.users.save({
        name: input.name,
        role: input.role,
        pinHash,
        phone: phoneDigits,
        email,
        accountId: account.id,
      });

      const settings = await session.storeSettings.findSingleton();
      const storeName = settings?.merchantName ?? "PDV";
      const body = inviteEmail({
        storeName,
        userName: input.name,
        loginUrl: `${input.origin ?? ""}/login`,
        tempPassword: temporaryPassword,
      });
      const sent = await this.deps.mailer.send({
        to: email,
        subject: body.subject,
        html: body.html,
        text: body.text,
      });
      if (!sent.sent) {
        // Throw → rollback: nem conta, nem usuário, nem senha nova (decisão 9).
        throw Errors.serviceUnavailable(
          "Não foi possível enviar o email de convite. Tente novamente.",
        );
      }
      return row;
    });

    // PIN em texto puro, uma única vez, pra exibição ao gerente (rota legada).
    return { ...serializeUser(created), pin };
  }
}
