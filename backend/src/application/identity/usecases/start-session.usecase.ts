/**
 * `POST /auth/session` — login da conta global (email + senha), §4.
 *
 * Anti-enumeração: email desconhecido, senha errada, conta suspensa e conta sem
 * senha (convite pendente, `password_hash NULL`) respondem o MESMO 401
 * `invalid_credentials`, e o caminho "email desconhecido" paga o mesmo custo de
 * argon2 (hash dummy) do caminho "senha errada" — sem isso o tempo de resposta
 * vira um oráculo de contas existentes.
 *
 * A resposta é a etapa 1 do fluxo (§5): o `accountToken` (10min) e a lista de
 * empresas vinculadas. A sessão de tenant só nasce no `select-tenant`.
 */
import argon2 from "argon2";
import { Errors } from "../../../domain/errors.js";
import type { IdentityDependencies } from "../ports/identity-dependencies.js";
import { normalizeEmail } from "../identity-helpers.js";
import { signAccountToken } from "../identity-tokens.js";

export function createStartSessionUsecase(deps: IdentityDependencies) {
  // Hash dummy calculado UMA vez, na primeira tentativa com email desconhecido
  // (argon2.hash custa ~100ms — no load do módulo atrasaria o boot sem motivo).
  let dummyHash: Promise<string> | null = null;
  function getDummyHash(): Promise<string> {
    dummyHash ??= argon2.hash("identidade-dummy-password");
    return dummyHash;
  }

  async function startSession(input: { email: string; password: string }) {
    const email = normalizeEmail(input.email);
    const account = email
      ? await deps.uow.run(deps.tenant(), (session) => session.identity.findAccountByEmail(email))
      : null;

    if (!account || !account.passwordHash || account.status !== "active") {
      await argon2.verify(await getDummyHash(), input.password).catch(() => false);
      throw Errors.accountInvalidCredentials();
    }

    const valid = await argon2.verify(account.passwordHash, input.password).catch(() => false);
    if (!valid) throw Errors.accountInvalidCredentials();

    const companies = await deps.tenants.listCompaniesForAccount(account.id);
    return {
      accountToken: signAccountToken(account.id, deps.jwtSecret),
      mustChangePassword: account.mustChangePassword,
      companies,
    };
  }

  return { startSession };
}

export type StartSessionUsecase = ReturnType<typeof createStartSessionUsecase>;
