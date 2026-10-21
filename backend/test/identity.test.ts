/**
 * Identidade centralizada (docs/26-identidade-centralizada.md §4) — suíte da
 * parte nova do login: conta global (email/senha), seleção de empresa, refresh
 * rotativo, recuperação de senha e convite.
 *
 * O que esta suíte protege, além do caminho feliz:
 *   - ANTI-ENUMERAÇÃO: senha errada, email desconhecido e convite pendente
 *     respondem o MESMO 401 (corpo e custo de argon2);
 *   - a SENHA TEMPORÁRIA nunca volta na API — só existe no corpo do email;
 *   - reuso de refresh derruba a FAMÍLIA (o token novo também morre);
 *   - convite sem SMTP não grava NADA (decisão 9);
 *   - `accountToken` não abre rota de tenant e token de tenant não abre as rotas
 *     de conta.
 *
 * Todas as contas criadas aqui usam o domínio `@ident.test`: o `afterEach`
 * apaga por esse domínio, então a suíte não deixa usuário nem conta para os
 * outros arquivos (o banco é compartilhado, `fileParallelism: false`).
 */
import argon2 from "argon2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api, closeTestApp, manager, raw, rawOwner, resetState, seedFixture } from "./helpers.js";
import { installTestMailer } from "./helpers/test-mailer.js";
import { runMigrations } from "../src/infra/db/migrate.js";
import { grantAppRoleOnSchema } from "../src/infra/db/ensure-app-role.js";
import { closeAllTenantPools } from "../src/infra/db/tenant-db.js";
import { runRegistryMigrations } from "../src/infra/db/registry-migrate.js";
import { invalidateTenantRegistryCache } from "../src/infra/tenant/registry.js";
import { resetRateLimit } from "../src/http/middlewares/rate-limit.middleware.js";

// Mailer fake no load do módulo: o adapter resolve `getMailer()` POR envio, então
// a instalação vale para todo o arquivo (e nenhum request sai para a rede).
const mailer = installTestMailer();

const EMAIL_DOMAIN = "@ident.test";
const PASSWORD = "senha-forte-1";

// `/auth/session` tem rate limit por IP (10/min) e o `forgot` 5/hora: cada teste
// começa com o mapa zerado, e os IPs são distintos para o caso de dois testes
// usarem a mesma rota em sequência.
let ipSeq = 0;
const nextIp = () => `10.77.0.${(ipSeq = (ipSeq % 250) + 1)}`;

let emailSeq = 0;
const uniqueEmail = (label: string) => `${label}-${(emailSeq += 1)}${EMAIL_DOMAIN}`;

// ---------------------------------------------------------------------------
// Fixtures da suíte: conta GLOBAL + linha `user` da loja default já vinculada.
// É o estado em que o login por email funciona (o vínculo nasce no convite ou
// no `npm run db:backfill-accounts`).
// ---------------------------------------------------------------------------
async function createLinkedAccount(opts: {
  label: string;
  password?: string;
  mustChangePassword?: boolean;
  role?: "waiter" | "manager" | "cashier";
  name?: string;
  active?: boolean;
}): Promise<{ accountId: string; email: string; userId: string; password: string }> {
  const email = uniqueEmail(opts.label);
  const password = opts.password ?? PASSWORD;
  const name = opts.name ?? "Conta Teste";
  const accountId = `acc-${crypto.randomUUID()}`;
  const userId = `usr-${crypto.randomUUID()}`;

  await raw.all(
    `INSERT INTO public.account (id, email, password_hash, name, status, must_change_password)
     VALUES ($1, $2, $3, $4, 'active', $5)`,
    [accountId, email, await argon2.hash(password), name, opts.mustChangePassword ?? false],
  );
  await raw.all(
    `INSERT INTO "user" (id, name, role, pin_hash, email, account_id, active)
     VALUES ($1, $2, $3, 'x', $4, $5, $6)`,
    [userId, name, opts.role ?? "manager", email, accountId, opts.active ?? true],
  );

  return { accountId, email, userId, password };
}

/** Conta SEM senha (`password_hash NULL`) — convite pendente ou vínculo dormente. */
async function createDormantAccount(label: string): Promise<{ accountId: string; email: string }> {
  const email = uniqueEmail(label);
  const accountId = `acc-${crypto.randomUUID()}`;
  await raw.all(
    `INSERT INTO public.account (id, email, password_hash, name, status, must_change_password)
     VALUES ($1, $2, NULL, 'Sem Senha', 'active', true)`,
    [accountId, email],
  );
  return { accountId, email };
}

const countRows = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await raw.get(sql, params)).count);

// ---------------------------------------------------------------------------
// Limpeza: tudo que a suíte cria usa `@ident.test`, então o domínio identifica
// o que apagar (o `resetState` NÃO apaga `user` nem `account` de propósito).
// ---------------------------------------------------------------------------
const TENANT_B_SCHEMA = "tenant_identity_b";

async function cleanupIdentityRows(): Promise<void> {
  const like = `%${EMAIL_DOMAIN}`;
  // A limpeza é do DONO (`rawOwner`), não do papel do app: com RLS ligado, o
  // papel do app só enxerga a linha da LOJA DA SESSÃO — o `user` da Loja B
  // (criado com o `tenant_id` de B) fica invisível ✗ e o `DELETE` da conta
  // batia na FK `user_account_id_fkey` com a linha "invisível" ainda viva.
  // O dono ignora a policy (superuser) e apaga tudo que a suíte criou.
  //
  // Vínculos no schema do teste multi-empresa (o catch cobre os describes onde o
  // schema nem existe — a limpeza é best-effort).
  await rawOwner
    .all(`UPDATE ${TENANT_B_SCHEMA}."user" SET account_id = NULL WHERE email LIKE $1`, [like])
    .catch(() => {});
  await rawOwner.all(`DELETE FROM ${TENANT_B_SCHEMA}."user" WHERE email LIKE $1`, [like]).catch(() => {});
  // `audit_log.user_id` é NO ACTION: filho primeiro (mesmo cuidado do profiles).
  await rawOwner.all(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM "user" WHERE email LIKE $1)`, [like]);
  await rawOwner.all(`DELETE FROM "user" WHERE email LIKE $1`, [like]);
  // auth_session/password_reset saem por ON DELETE CASCADE.
  await rawOwner.all(`DELETE FROM public.account WHERE email LIKE $1`, [like]);
}

beforeAll(async () => {
  await seedFixture();
  // O registry tem runner próprio e o global setup só aplica `migrations/*.sql`;
  // aqui a suíte garante as tabelas globais de identidade (o boot faz o mesmo).
  await runRegistryMigrations();
});

afterAll(async () => {
  await cleanupIdentityRows();
  await closeTestApp();
});

beforeEach(async () => {
  await resetState();
  mailer.reset();
  mailer.setConfigured(true);
  resetRateLimit();
});

afterEach(async () => {
  await cleanupIdentityRows();
});

// ---------------------------------------------------------------------------
// 1. Anti-enumeração e o 401 único
// ---------------------------------------------------------------------------
describe("identidade: POST /auth/session (401 genérico)", () => {
  it("senha errada e email desconhecido devolvem o MESMO corpo", async () => {
    const { email } = await createLinkedAccount({ label: "generico" });

    const senhaErrada = await api("post", "/auth/session", {
      body: { email, password: "senha-errada-9" },
      ip: nextIp(),
    });
    const emailDesconhecido = await api("post", "/auth/session", {
      body: { email: uniqueEmail("nunca-existiu"), password: PASSWORD },
      ip: nextIp(),
    });

    expect(senhaErrada.status).toBe(401);
    expect(emailDesconhecido.status).toBe(401);
    // Corpo IDÊNTICO: a diferença entre "senha errada" e "não existe" seria um
    // oráculo de contas cadastradas.
    expect(senhaErrada.json).toEqual(emailDesconhecido.json);
    expect(senhaErrada.json.error.code).toBe("invalid_credentials");
    // Mensagem do login por email (a rota `/auth/login` do PIN continua com a
    // dela — o contrato preserva o fallback).
    expect(senhaErrada.json.error.message).toBe("E-mail ou senha incorretos.");
  });

  it("conta sem senha (convite pendente) cai no mesmo 401", async () => {
    const { email } = await createDormantAccount("dormante");
    const res = await api("post", "/auth/session", { body: { email, password: PASSWORD }, ip: nextIp() });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("invalid_credentials");
  });

  it("payload sem email/senha é 400 de validação (não 401)", async () => {
    const res = await api("post", "/auth/session", { body: { email: "", password: "" }, ip: nextIp() });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation_failed");
  });
});

// ---------------------------------------------------------------------------
// 2. Sessão, seleção de empresa e a separação dos dois tokens
// ---------------------------------------------------------------------------
describe("identidade: session → select-tenant", () => {
  it("session devolve accountToken + empresas e select-tenant devolve a sessão da loja", async () => {
    const { email, userId, password } = await createLinkedAccount({ label: "empresa-unica" });

    const session = await api("post", "/auth/session", { body: { email, password }, ip: nextIp() });
    expect(session.status).toBe(200);
    expect(session.json.mustChangePassword).toBe(false);
    expect(typeof session.json.accountToken).toBe("string");
    // A instalação de loja única não tem linha no registry: o default PRECISA
    // aparecer, senão a tela diz "nenhuma empresa vinculada" para todo mundo.
    expect(session.json.companies).toHaveLength(1);
    expect(session.json.companies[0]).toMatchObject({ slug: "default", name: "Teste Café" });

    const select = await api("post", "/auth/select-tenant", {
      token: session.json.accountToken,
      body: { slug: "default" },
      ip: nextIp(),
    });
    expect(select.status).toBe(200);
    expect(select.json.token).toBeTruthy();
    expect(select.json.refreshToken).toBeTruthy();
    // Refresh é OPACO e diferente do JWT (o banco guarda só o SHA-256).
    expect(select.json.refreshToken).not.toBe(select.json.token);
    expect(select.json.user).toMatchObject({ id: userId, role: "manager" });
    expect("accountId" in select.json.user).toBe(false);

    // O token de tenant abre a sessão normal do app.
    const me = await api("get", "/auth/me", { token: select.json.token });
    expect(me.status).toBe(200);
    expect(me.json.id).toBe(userId);
  });

  it("accountToken não abre rota de tenant (GET /auth/me → 401)", async () => {
    const { email, password } = await createLinkedAccount({ label: "token-de-conta" });
    const session = await api("post", "/auth/session", { body: { email, password }, ip: nextIp() });
    expect(session.status).toBe(200);

    const me = await api("get", "/auth/me", { token: session.json.accountToken });
    expect(me.status).toBe(401);
    expect(me.json.error.code).toBe("unauthorized");
  });

  it("select-tenant em loja sem vínculo é 403 tenant_not_linked (nunca 404)", async () => {
    const { email, password } = await createLinkedAccount({ label: "sem-vinculo" });
    const session = await api("post", "/auth/session", { body: { email, password }, ip: nextIp() });

    const res = await api("post", "/auth/select-tenant", {
      token: session.json.accountToken,
      body: { slug: "loja-que-nao-existe" },
      ip: nextIp(),
    });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("tenant_not_linked");
    expect(res.json.error.details).toEqual({ slug: "loja-que-nao-existe" });
  });

  it("select-tenant sem Bearer é 401", async () => {
    const res = await api("post", "/auth/select-tenant", { body: { slug: "default" }, ip: nextIp() });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("unauthorized");
  });
});

// ---------------------------------------------------------------------------
// 3. Troca obrigatória de senha (decisão 8)
// ---------------------------------------------------------------------------
describe("identidade: POST /auth/password/change", () => {
  it("must_change_password bloqueia a sessão de loja e a troca destrava", async () => {
    const { email, userId, password } = await createLinkedAccount({
      label: "troca-obrigatoria",
      password: "temp-inicial-1",
      mustChangePassword: true,
    });

    const session = await api("post", "/auth/session", { body: { email, password }, ip: nextIp() });
    expect(session.status).toBe(200);
    expect(session.json.mustChangePassword).toBe(true);

    const bloqueado = await api("post", "/auth/select-tenant", {
      token: session.json.accountToken,
      body: { slug: "default" },
      ip: nextIp(),
    });
    expect(bloqueado.status).toBe(401);
    expect(bloqueado.json.error.code).toBe("password_change_required");

    const trocada = await api("post", "/auth/password/change", {
      token: session.json.accountToken,
      body: { newPassword: "senha-nova-do-dono-2" },
      ip: nextIp(),
    });
    expect(trocada.status).toBe(200);
    expect(trocada.json).toEqual({ ok: true });

    // O MESMO accountToken (10min) já passa: o bloqueio é o `must_change_password`.
    const liberado = await api("post", "/auth/select-tenant", {
      token: session.json.accountToken,
      body: { slug: "default" },
      ip: nextIp(),
    });
    expect(liberado.status).toBe(200);
    expect(liberado.json.user.id).toBe(userId);

    // A senha antiga morreu e a nova vale.
    const comAntiga = await api("post", "/auth/session", { body: { email, password }, ip: nextIp() });
    expect(comAntiga.status).toBe(401);
    const comNova = await api("post", "/auth/session", {
      body: { email, password: "senha-nova-do-dono-2" },
      ip: nextIp(),
    });
    expect(comNova.status).toBe(200);
    expect(comNova.json.mustChangePassword).toBe(false);
  });

  it("senha fora da política é 400 password_too_short com mensagem amigável", async () => {
    const { email, password } = await createLinkedAccount({ label: "curta" });
    const session = await api("post", "/auth/session", { body: { email, password }, ip: nextIp() });

    const res = await api("post", "/auth/password/change", {
      token: session.json.accountToken,
      body: { newPassword: "curta" },
      ip: nextIp(),
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("password_too_short");
    expect(res.json.error.details).toEqual({ min: 8, max: 128 });
    expect(res.json.error.message).toContain("entre 8 e 128");
  });
});

// ---------------------------------------------------------------------------
// 4. Refresh rotativo + logout idempotente (decisão 2)
// ---------------------------------------------------------------------------
describe("identidade: POST /auth/refresh e /auth/logout", () => {
  async function sessionFor(label: string) {
    const account = await createLinkedAccount({ label });
    const session = await api("post", "/auth/session", {
      body: { email: account.email, password: account.password },
      ip: nextIp(),
    });
    const select = await api("post", "/auth/select-tenant", {
      token: session.json.accountToken,
      body: { slug: "default" },
      ip: nextIp(),
    });
    expect(select.status).toBe(200);
    return { ...account, refreshToken: select.json.refreshToken as string, token: select.json.token as string };
  }

  it("rotação: o refresh consumido não vale mais, o novo vale", async () => {
    const { refreshToken } = await sessionFor("rotacao");

    const girado = await api("post", "/auth/refresh", { body: { refreshToken }, ip: nextIp() });
    expect(girado.status).toBe(200);
    expect(girado.json.refreshToken).toBeTruthy();
    expect(girado.json.refreshToken).not.toBe(refreshToken);
    expect(girado.json.token).toBeTruthy();

    const reusado = await api("post", "/auth/refresh", { body: { refreshToken }, ip: nextIp() });
    expect(reusado.status).toBe(401);
    expect(reusado.json.error.code).toBe("unauthorized");
  });

  it("REUSO de refresh revoga a FAMÍLIA inteira (o token novo também morre)", async () => {
    const { refreshToken: r0 } = await sessionFor("reuso");

    const r1 = (await api("post", "/auth/refresh", { body: { refreshToken: r0 }, ip: nextIp() })).json
      .refreshToken as string;
    expect(r1).toBeTruthy();

    // Alguém reapresenta o r0 (vazado): 401 + a família toda cai.
    const roubo = await api("post", "/auth/refresh", { body: { refreshToken: r0 }, ip: nextIp() });
    expect(roubo.status).toBe(401);

    const depois = await api("post", "/auth/refresh", { body: { refreshToken: r1 }, ip: nextIp() });
    expect(depois.status).toBe(401);
  });

  it("logout é idempotente (200 sempre) e mata o refresh", async () => {
    const { refreshToken } = await sessionFor("logout");

    const primeiro = await api("post", "/auth/logout", { body: { refreshToken }, ip: nextIp() });
    expect(primeiro.status).toBe(200);
    expect(primeiro.json).toEqual({ ok: true });

    const segundo = await api("post", "/auth/logout", { body: { refreshToken }, ip: nextIp() });
    expect(segundo.status).toBe(200);
    expect(segundo.json).toEqual({ ok: true });

    // Token que nunca existiu também é 200 (o cliente não precisa de estado).
    const desconhecido = await api("post", "/auth/logout", { body: { refreshToken: "nao-existe" }, ip: nextIp() });
    expect(desconhecido.status).toBe(200);

    const depois = await api("post", "/auth/refresh", { body: { refreshToken }, ip: nextIp() });
    expect(depois.status).toBe(401);
  });

  it("refresh desconhecido é 401 (sem família para revogar)", async () => {
    const res = await api("post", "/auth/refresh", { body: { refreshToken: "token-inventado" }, ip: nextIp() });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 5. Recuperação de senha
// ---------------------------------------------------------------------------
describe("identidade: /auth/password/forgot e /auth/password/reset", () => {
  it("sem SMTP devolve 503 email_not_configured e não grava pedido", async () => {
    const { email } = await createLinkedAccount({ label: "sem-smtp" });
    mailer.setConfigured(false);

    const antes = await countRows("SELECT count(*)::int AS count FROM public.password_reset");
    const res = await api("post", "/auth/password/forgot", {
      body: { email },
      ip: nextIp(),
      headers: { host: "pdv.teste.local" },
    });
    const depois = await countRows("SELECT count(*)::int AS count FROM public.password_reset");

    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe("email_not_configured");
    // Nada é gravado: o 503 é a resposta para o endpoint inteiro, não só para
    // quem tem conta (a checagem de SMTP vem ANTES da consulta).
    expect(depois).toBe(antes);
    expect(mailer.sent).toHaveLength(0);
  });

  it("com SMTP é 202 para conta existente e para desconhecida (não enumera)", async () => {
    const { email } = await createLinkedAccount({ label: "com-smtp" });

    const existente = await api("post", "/auth/password/forgot", {
      body: { email },
      ip: nextIp(),
      headers: { host: "pdv.teste.local" },
    });
    const desconhecida = await api("post", "/auth/password/forgot", {
      body: { email: uniqueEmail("fantasma") },
      ip: nextIp(),
      headers: { host: "pdv.teste.local" },
    });

    expect(existente.status).toBe(202);
    expect(desconhecida.status).toBe(202);
    expect(existente.json).toEqual({ ok: true });
    expect(desconhecida.json).toEqual({ ok: true });
    // Só a conta existente gerou email (1, não 2).
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe(email);
    // O link é ABSOLUTO, montado a partir do host do request.
    expect(mailer.sent[0].text).toContain("http://pdv.teste.local/reset-password?token=");
  });

  it("reset troca a senha e o token é de uso único; inválido/expirado é 400", async () => {
    const { email, password } = await createLinkedAccount({ label: "reset" });

    await api("post", "/auth/password/forgot", {
      body: { email },
      ip: nextIp(),
      headers: { host: "pdv.teste.local" },
    });
    const token = mailer.lastResetToken();

    const trocado = await api("post", "/auth/password/reset", {
      body: { token, newPassword: "senha-recuperada-3" },
      ip: nextIp(),
    });
    expect(trocado.status).toBe(200);
    expect(trocado.json).toEqual({ ok: true });

    // Uso único: o mesmo token não troca de novo.
    const reusado = await api("post", "/auth/password/reset", {
      body: { token, newPassword: "outra-senha-qualquer-4" },
      ip: nextIp(),
    });
    expect(reusado.status).toBe(400);
    expect(reusado.json.error.code).toBe("password_token_invalid");

    const lixo = await api("post", "/auth/password/reset", {
      body: { token: "token-que-nunca-existiu", newPassword: "senha-qualquer-5" },
      ip: nextIp(),
    });
    expect(lixo.json.error.code).toBe("password_token_invalid");

    // Expirado: a linha existe, mas com `expires_at` no passado.
    const { accountId } = await (async () => {
      const conta = await createLinkedAccount({ label: "expirado" });
      await api("post", "/auth/password/forgot", {
        body: { email: conta.email },
        ip: nextIp(),
        headers: { host: "pdv.teste.local" },
      });
      const expirado = mailer.lastResetToken();
      await raw.all(`UPDATE public.password_reset SET expires_at = '2000-01-01T00:00:00.000Z' WHERE account_id = $1`, [
        conta.accountId,
      ]);
      const res = await api("post", "/auth/password/reset", {
        body: { token: expirado, newPassword: "senha-nova-6" },
        ip: nextIp(),
      });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("password_token_invalid");
      return conta;
    })();
    expect(accountId).toBeTruthy();

    // A troca valeu: a senha antiga morreu, a nova entra, e o login não pede
    // mais troca (`must_change_password` volta a false no reset).
    expect((await api("post", "/auth/session", { body: { email, password }, ip: nextIp() })).status).toBe(401);
    const comNova = await api("post", "/auth/session", {
      body: { email, password: "senha-recuperada-3" },
      ip: nextIp(),
    });
    expect(comNova.status).toBe(200);
    expect(comNova.json.mustChangePassword).toBe(false);
  });

  it("reset derruba as sessões de refresh abertas", async () => {
    const { email, password } = await createLinkedAccount({ label: "reset-sessoes" });
    const session = await api("post", "/auth/session", { body: { email, password }, ip: nextIp() });
    const select = await api("post", "/auth/select-tenant", {
      token: session.json.accountToken,
      body: { slug: "default" },
      ip: nextIp(),
    });
    const refreshToken = select.json.refreshToken as string;
    expect((await api("post", "/auth/refresh", { body: { refreshToken }, ip: nextIp() })).status).toBe(200);

    await api("post", "/auth/password/forgot", {
      body: { email },
      ip: nextIp(),
      headers: { host: "pdv.teste.local" },
    });
    const reset = await api("post", "/auth/password/reset", {
      body: { token: mailer.lastResetToken(), newPassword: "senha-pos-reset-7" },
      ip: nextIp(),
    });
    expect(reset.status).toBe(200);

    const depois = await api("post", "/auth/refresh", { body: { refreshToken }, ip: nextIp() });
    expect(depois.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 6. Convite (POST /users) e vínculo por PATCH /users/:id
// ---------------------------------------------------------------------------
describe("identidade: convite e vínculo de conta", () => {
  it("POST /users exige email e manda a senha temporária por email (nunca na resposta)", async () => {
    const email = uniqueEmail("convidado");
    const criado = await api("post", "/users", {
      token: manager,
      body: { name: "Convidado Novo", role: "waiter", email },
      ip: nextIp(),
      headers: { host: "pdv.teste.local" },
    });

    expect(criado.status).toBe(201);
    // O PIN continua saindo uma única vez (rota legada do app desktop).
    expect(criado.json.pin).toMatch(/^\d{4}$/);
    // A senha temporária NÃO volta na resposta — só existe no email.
    expect(criado.json.password).toBeUndefined();
    expect(criado.json.tempPassword).toBeUndefined();
    expect(criado.json.accountId).toBeUndefined();
    expect(JSON.stringify(criado.json)).not.toContain("tempPassword");

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe(email);
    expect(mailer.sent[0].text).toContain("http://pdv.teste.local/login");
    const tempPassword = /senha temporária: (\S+)/.exec(mailer.sent[0].text)?.[1];
    expect(tempPassword).toMatch(/^[A-Za-z0-9]{10}$/);

    // A conta nasceu com troca obrigatória e o usuário aponta para ela.
    const link = await raw.get(`SELECT account_id, email FROM "user" WHERE id = $1`, [criado.json.id]);
    expect(link.email).toBe(email);
    expect(link.account_id).toBeTruthy();
    const account = await raw.get(`SELECT must_change_password, password_hash FROM public.account WHERE id = $1`, [
      link.account_id,
    ]);
    expect(account.must_change_password).toBe(true);
    expect(account.password_hash).toBeTruthy();

    // Fluxo completo com a senha do email: a senha temporária entra, só troca, e
    // a senha própria passa a valer.
    const session = await api("post", "/auth/session", {
      body: { email, password: tempPassword },
      ip: nextIp(),
    });
    expect(session.status).toBe(200);
    expect(session.json.mustChangePassword).toBe(true);

    const bloqueado = await api("post", "/auth/select-tenant", {
      token: session.json.accountToken,
      body: { slug: "default" },
      ip: nextIp(),
    });
    expect(bloqueado.json.error.code).toBe("password_change_required");

    const trocada = await api("post", "/auth/password/change", {
      token: session.json.accountToken,
      body: { newPassword: "senha-propria-8" },
      ip: nextIp(),
    });
    expect(trocada.status).toBe(200);

    const selecionado = await api("post", "/auth/select-tenant", {
      token: session.json.accountToken,
      body: { slug: "default" },
      ip: nextIp(),
    });
    expect(selecionado.status).toBe(200);
    expect(selecionado.json.user.id).toBe(criado.json.id);
    expect(selecionado.json.user.role).toBe("waiter");
  });

  it("convite sem SMTP é 503 e NÃO grava conta nem usuário (decisão 9)", async () => {
    const email = uniqueEmail("sem-smtp-convite");
    mailer.setConfigured(false);

    const res = await api("post", "/users", {
      token: manager,
      body: { name: "Não Deve Existir", role: "waiter", email },
      ip: nextIp(),
    });

    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe("email_not_configured");
    expect(await countRows(`SELECT count(*)::int AS count FROM "user" WHERE email = $1`, [email])).toBe(0);
    expect(await countRows(`SELECT count(*)::int AS count FROM public.account WHERE email = $1`, [email])).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it("POST /users sem email é 400 (o email é o identificador da conta)", async () => {
    const res = await api("post", "/users", {
      token: manager,
      body: { name: "Sem Email", role: "waiter" },
      ip: nextIp(),
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation_failed");
    expect(mailer.sent).toHaveLength(0);
  });

  it("PATCH /users/:id liga a conta pelo email novo e desliga no email nulo, sem enviar email", async () => {
    const email = uniqueEmail("vincular");
    const criado = await api("post", "/users", {
      token: manager,
      body: { name: "Vai Vincular", role: "cashier", email },
      ip: nextIp(),
    });
    expect(criado.status).toBe(201);
    const primeiroLink = await raw.get(`SELECT account_id FROM "user" WHERE id = $1`, [criado.json.id]);

    const outroEmail = uniqueEmail("vinculo-novo");
    const trocado = await api("patch", `/users/${criado.json.id}`, {
      token: manager,
      body: { email: outroEmail },
      ip: nextIp(),
    });
    expect(trocado.status).toBe(200);
    expect(trocado.json.email).toBe(outroEmail);
    // Trocar o email liga a OUTRA conta (a antiga fica órfã) e a nova nasce
    // DORMENTE: quem define credencial é o convite, não um PATCH.
    const segundoLink = await raw.get(`SELECT account_id FROM "user" WHERE id = $1`, [criado.json.id]);
    expect(segundoLink.account_id).toBeTruthy();
    expect(segundoLink.account_id).not.toBe(primeiroLink.account_id);
    const novaConta = await raw.get(`SELECT email, password_hash FROM public.account WHERE id = $1`, [
      segundoLink.account_id,
    ]);
    expect(novaConta.email).toBe(outroEmail);
    expect(novaConta.password_hash).toBeNull();
    // Um único email na caixa: o PATCH não envia nada.
    expect(mailer.sent).toHaveLength(1);

    // Email nulo desvincula (o PIN continua funcionando).
    const desvinculado = await api("patch", `/users/${criado.json.id}`, {
      token: manager,
      body: { email: null },
      ip: nextIp(),
    });
    expect(desvinculado.status).toBe(200);
    expect(desvinculado.json.email).toBeNull();
    expect((await raw.get(`SELECT account_id FROM "user" WHERE id = $1`, [criado.json.id])).account_id).toBeNull();
    expect(mailer.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Multi-empresa: duas lojas na mesma conta (routing ligado)
// ---------------------------------------------------------------------------
describe("identidade: conta com duas empresas", () => {
  const ROOT_DOMAIN = "ident.test";
  const TENANT_B_SLUG = "loja-b";
  // Id fixo do tenant B: o mesmo vai para a linha do registry e para a coluna
  // `tenant_id` das linhas (é o que a policy de RLS compara).
  const TENANT_B_ID = "bbbbbbbb-2222-3333-4444-55555555555b";
  const ENV_KEYS = ["TENANT_ROUTING", "PLATFORM_ROOT_DOMAIN", "DEFAULT_TENANT_SCHEMA"] as const;
  const savedEnv = new Map<string, string | undefined>();

  let account: { accountId: string; email: string; userId: string; password: string };

  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    process.env.TENANT_ROUTING = "true";
    process.env.PLATFORM_ROOT_DOMAIN = ROOT_DOMAIN;

    // Segunda loja de verdade: a linha no registry + a marca dela + o usuário
    // da conta com OUTRA role (a role do token vem da linha `user` da loja).
    //
    // A loja NÃO tem schema: no modelo por linha (`docs/28`) as lojas
    // convivem no `public` e quem separa uma da outra é a coluna `tenant_id`
    // (a policy de RLS filtra a leitura).
    //
    // A linha do registry ANTES do dado: a FK `store_settings →
    // public.tenant` recusa o dado de um tenant que não está no registry.
    await raw.all(
      `INSERT INTO public.tenant (id, slug, schema_name, display_name, status)
       VALUES ($1, $2, 'public', $3, 'active')
       ON CONFLICT (slug) DO UPDATE SET id = EXCLUDED.id`,
      [TENANT_B_ID, TENANT_B_SLUG, "Loja B"],
    );
    // O `SET` é da sessão do INSERT: a policy de RLS exige que a linha
    // escrita seja da loja da sessão.
    // `set_config(..., true)` e NÃO `SET`: o `SET` é de SESSÃO e vazaria para
    // a conexão do POOL (que é reutilizada) — o `app.tenant_id` da Loja B
    // ficava pendurado na conexão do default e a policy escondia os dados do
    // default. O `is_local=true` vale só até o fim da transação.
    await raw.exec(
      `SELECT set_config('app.tenant_id', '${TENANT_B_ID}', true);
       INSERT INTO store_settings
         (id, merchant_name, merchant_city, brand_color, uses_delivery, kitchen_enabled)
       VALUES ('singleton', 'Loja B', 'Cidade B', '#654321', false, false)
       ON CONFLICT (tenant_id, id) DO UPDATE
         SET merchant_name = EXCLUDED.merchant_name, brand_color = EXCLUDED.brand_color`,
    );
    invalidateTenantRegistryCache();

    account = await createLinkedAccount({ label: "duas-empresas", role: "manager" });
    // O `SET` é da sessão do INSERT: a policy de RLS exige que a linha escrita
    // seja da loja da sessão (e o trigger preenche o `tenant_id`).
    await raw.exec(
      `SELECT set_config('app.tenant_id', '${TENANT_B_ID}', true);
       INSERT INTO "user" (id, name, role, pin_hash, email, account_id)
       VALUES ('usr-b-${crypto.randomUUID()}', 'Gerente na Loja B', 'waiter', 'x', '${account.email}', '${account.accountId}')`,
    );
  });

  afterAll(async () => {
    // O afterEach do arquivo limpa os vínculos e o dado da loja.
    await rawOwner.exec(`DELETE FROM store_settings WHERE tenant_id = '${TENANT_B_ID}'`);
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    invalidateTenantRegistryCache();
  });

  afterEach(async () => {
    // O DONO, e NESTA ORDEM: as FKs `user/store_settings → public.tenant` são
    // verificadas com as linhas REAIS (o RLS não esconde a linha da Loja B do
    // verificador da FK) e o papel do app não a enxerga → o dado da loja sai
    // ANTES da linha do registry, senão o DELETE da linha bate na FK.
    await rawOwner.exec(`DELETE FROM "user" WHERE tenant_id = '${TENANT_B_ID}' AND email LIKE '%${EMAIL_DOMAIN}'`);
    await rawOwner.exec(`DELETE FROM store_settings WHERE tenant_id = '${TENANT_B_ID}'`);
    await rawOwner.all(`DELETE FROM public.tenant WHERE slug = $1`, [TENANT_B_SLUG]);
    invalidateTenantRegistryCache();
  });

  beforeEach(async () => {
    // O `beforeEach` do arquivo já zerou o registry? Não — o seedRegistry do
    // arquivo não existe aqui, então a linha do tenant B é reposta a cada
    // teste. O id é FIXO: é o mesmo que vai na coluna `tenant_id` das linhas da
    // loja (é o que a policy de RLS compara) — um id aleatório deixaria o
    // dado da loja invisível para o contexto.
    await raw.all(
      `INSERT INTO public.tenant (id, slug, schema_name, display_name, status)
       VALUES ($1, $2, $3, 'Loja B', 'active')
       ON CONFLICT (slug) DO UPDATE SET id = EXCLUDED.id, schema_name = EXCLUDED.schema_name, status = 'active'`,
      [TENANT_B_ID, TENANT_B_SLUG, TENANT_B_SCHEMA],
    );
    // A marca da loja. O `set_config(..., true)` é de TRANSAÇÃO: um `SET` de
    // sessão vazaria para a conexão do POOL (reutilizada) e o `app.tenant_id`
    // da Loja B ficaria pendurado nela — envenenando o default.
    await raw.exec(
      `SELECT set_config('app.tenant_id', '${TENANT_B_ID}', true);
       INSERT INTO store_settings
         (id, merchant_name, merchant_city, brand_color, uses_delivery, kitchen_enabled)
       VALUES ('singleton', 'Loja B', 'Cidade B', '#654321', false, false)
       ON CONFLICT (tenant_id, id) DO UPDATE SET brand_color = EXCLUDED.brand_color`,
    );
    invalidateTenantRegistryCache();
  });

  it("session lista as duas empresas (default primeiro) e o token carrega a role da loja", async () => {
    const session = await api("post", "/auth/session", {
      body: { email: account.email, password: account.password },
      ip: nextIp(),
      headers: { host: ROOT_DOMAIN },
    });
    expect(session.status).toBe(200);
    expect(session.json.companies.map((c: any) => c.slug)).toEqual(["default", TENANT_B_SLUG]);
    expect(session.json.companies.map((c: any) => c.name)).toEqual(["Teste Café", "Loja B"]);
    expect(session.json.companies[1].primaryColor).toBe("#654321");

    const select = await api("post", "/auth/select-tenant", {
      token: session.json.accountToken,
      body: { slug: TENANT_B_SLUG },
      ip: nextIp(),
      headers: { host: ROOT_DOMAIN },
    });
    expect(select.status).toBe(200);
    // A role vem da linha `user` DESTA loja (waiter), não da loja default.
    expect(select.json.user.role).toBe("waiter");

    // E o token vale na loja para a qual foi emitido.
    const me = await api("get", "/auth/me", {
      token: select.json.token,
      headers: { host: `${TENANT_B_SLUG}.${ROOT_DOMAIN}` },
    });
    expect(me.status).toBe(200);
    expect(me.json.role).toBe("waiter");
  });

  it("select-tenant de loja vizinha sem vínculo é 403 e a conta continua só com a dela", async () => {
    const soDefault = await createLinkedAccount({ label: "so-default" });

    const session = await api("post", "/auth/session", {
      body: { email: soDefault.email, password: soDefault.password },
      ip: nextIp(),
      headers: { host: ROOT_DOMAIN },
    });
    expect(session.json.companies.map((c: any) => c.slug)).toEqual(["default"]);

    const vizinha = await api("post", "/auth/select-tenant", {
      token: session.json.accountToken,
      body: { slug: TENANT_B_SLUG },
      ip: nextIp(),
      headers: { host: ROOT_DOMAIN },
    });
    expect(vizinha.status).toBe(403);
    expect(vizinha.json.error.code).toBe("tenant_not_linked");
  });
});
