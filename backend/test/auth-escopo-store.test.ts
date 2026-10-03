import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { api, seedFixture, resetState, closeTestApp, manager, raw, tokenOf, FIXTURE } from "./helpers.js";

// Identidade escopada por loja (PR multi-tenant "A") — dois buracos:
//
//   1. GET /auth/users (tela de seleção do login, ANTES da autenticação) só
//      devolve a equipe DA LOJA resolvida. Antes filtrava só `active = true`
//      e o visitante do subdomínio da loja A via nomes/fotos/papéis de todas
//      as lojas;
//   2. POST /auth/login só autentica usuário da loja resolvida. Antes um PIN
//      válido da loja B logava pela superfície da loja A — confirmando que o
//      userId existia e expondo o brute force de PIN a outra superfície.
//
// "Loja A" = store default (…0001, slug 'default'), que é onde caem os
// requests de teste sem subdomínio (Host localhost). "Loja B" é uma store
// criada por esta suíte, com slug 'loja-b' pra também dar pra forçar o
// tenant pelo header Host (subdomínio), como em produção.

const STORE_DEFAULT = "00000000-0000-0000-0000-000000000001";
const LOJA_B = "00000000-0000-0000-0000-000000000098";
const USER_A = "u-loja-a";
const USER_B = "u-loja-b";
const USER_LEGADO = "u-loja-legado";

/** Força o tenant pela resolução por header X-Store-ID (apps desktop/mobile). */
const naLojaB = { headers: { "x-store-id": LOJA_B } };
/** Força o tenant pelo subdomínio do Host, como no domínio de produção. */
const hostLojaB = { headers: { host: "loja-b.labolabe.tech" } };

// POST /auth/login tem rate limit por IP (10/min, rate-limit.middleware).
// Cada chamada leva um IP próprio — mesmo truque das rotas públicas em
// self-service.test.ts — pra o limite nunca mascarar o que se quer provar.
let ipSeq = 0;
const nextIp = () => `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

async function login(userId: string, pin: string, opts: { headers?: Record<string, string> } = {}) {
  return api("post", "/auth/login", { body: { userId, pin }, ip: nextIp(), ...opts });
}

async function criaUsuario(id: string, name: string, storeId: string | null, pin: string) {
  const pinHash = await argon2.hash(pin);
  await raw.all(
    `INSERT INTO "user" (id, name, role, pin_hash, store_id)
     VALUES ($1, $2, 'waiter', $3, $4)
     ON CONFLICT (id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, store_id = EXCLUDED.store_id, failed_attempts = 0, locked_until = NULL`,
    [id, name, pinHash, storeId]
  );
}

async function criaLojaB() {
  await raw.all(
    `INSERT INTO stores (id, name, slug, status) VALUES ($1, 'Loja B', 'loja-b', 'active') ON CONFLICT (id) DO NOTHING`,
    [LOJA_B]
  );
  // A migration 0011 só roda uma vez, então nasce settings manualmente
  // (mesmo bloco que ela recomenda pra store nova — ver cabeçalho da 0011).
  await raw.all(
    `INSERT INTO store_settings (id, store_id, merchant_name, merchant_city)
     VALUES ($1, $1, 'Loja B', '') ON CONFLICT (id) DO NOTHING`,
    [LOJA_B]
  );
}

function ids(res: { json: any }): string[] {
  return res.json.map((u: { id: string }) => u.id);
}

describe("identidade escopada por loja (GET /auth/users + POST /auth/login)", () => {
  beforeAll(async () => {
    await seedFixture();
    await criaLojaB();
    // Loja A: dono com store_id explícito da default; loja B: equipe da outra
    // loja; legado: store_id NULL (dado de antes da 0008) — a decisão é que
    // ele só caiba na loja default (ver application/auth/user-store-scope.ts).
    await criaUsuario(USER_A, "Ana Loja A", STORE_DEFAULT, "1111");
    await criaUsuario(USER_B, "Bia Loja B", LOJA_B, "2222");
    await criaUsuario(USER_LEGADO, "Legado Sem Loja", null, "3333");
  });

  afterAll(async () => {
    await raw.all(`DELETE FROM "user" WHERE id LIKE 'u-loja-%'`);
    await raw.all(`DELETE FROM store_settings WHERE store_id = $1`, [LOJA_B]);
    await raw.all(`DELETE FROM stores WHERE id = $1`, [LOJA_B]);
    await closeTestApp();
  });

  beforeEach(() => resetState());

  // ------------------------------------------------------------------ lista
  it("sem token, o visitante do subdomínio da loja A vê só a equipe da loja A", async () => {
    const res = await api("get", "/auth/users");
    expect(res.status).toBe(200);

    const visiveis = ids(res);
    expect(visiveis).toContain(USER_A); // store_id explícito da default
    expect(visiveis).toContain(FIXTURE.waiter); // store_id NULL cai na default
    expect(visiveis).not.toContain(USER_B); // equipe da loja B some
    expect(res.json.map((u: { name: string }) => u.name)).not.toContain("Bia Loja B");
  });

  it("loja A logada não vê usuários da loja B", async () => {
    const gerenteDaLojaA = tokenOf(FIXTURE.manager, "manager", STORE_DEFAULT);
    const res = await api("get", "/auth/users", { token: gerenteDaLojaA });
    expect(res.status).toBe(200);

    const visiveis = ids(res);
    expect(visiveis).toContain(USER_A);
    expect(visiveis).not.toContain(USER_B);
    expect(res.json.map((u: { name: string }) => u.name)).not.toContain("Bia Loja B");
  });

  it("na loja B (X-Store-ID ou Host) só aparece a equipe da loja B", async () => {
    for (const contexto of [naLojaB, hostLojaB]) {
      const res = await api("get", "/auth/users", contexto);
      expect(res.status).toBe(200);

      const visiveis = ids(res);
      expect(visiveis).toContain(USER_B);
      expect(visiveis).not.toContain(USER_A);
      expect(visiveis).not.toContain(USER_LEGADO); // NULL não cai em loja que não é a default
      expect(visiveis).not.toContain(FIXTURE.waiter);
    }
  });

  it("o token devolvido pelo login da loja B também só enxerga a loja B", async () => {
    const logado = await login(USER_B, "2222", naLojaB);
    expect(logado.status).toBe(200);

    // O JWT carrega storeId e o tenant middleware o usa como fonte #1 —
    // sem precisar de subdomínio nem X-Store-ID.
    const res = await api("get", "/auth/users", { token: logado.json.token });
    expect(res.status).toBe(200);
    expect(ids(res)).toContain(USER_B);
    expect(ids(res)).not.toContain(USER_A);
  });

  // ------------------------------------------------------------------ login
  it("login legítimo na própria loja continua funcionando", async () => {
    const ok = await login(USER_A, "1111");
    expect(ok.status).toBe(200);
    expect(ok.json.token).toBeTruthy();
    expect(ok.json.user).toMatchObject({ id: USER_A, name: "Ana Loja A", role: "waiter" });

    // Mesmo usuário logado a partir do contexto da própria loja B.
    const naSuaLoja = await login(USER_B, "2222", naLojaB);
    expect(naSuaLoja.status).toBe(200);
    expect(naSuaLoja.json.user.id).toBe(USER_B);
  });

  it("login de usuário da loja B no contexto da loja A é recusado (401)", async () => {
    // PIN correto de propósito: o que se prova é que a LOJA errada derruba,
    // não o PIN.
    const res = await login(USER_B, "2222");
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("invalid_credentials");
    expect(res.json.error.message).toBe("PIN incorreto.");
  });

  it("a recusa cross-store não vaza que o usuário existe em outra loja", async () => {
    const deOutraLoja = await login(USER_B, "2222");
    const idQueNaoExiste = await login("u-que-nao-existe", "2222");

    expect(deOutraLoja.status).toBe(401);
    expect(idQueNaoExiste.status).toBe(401);
    // Mesmo corpo de erro, byte a byte: anti-enumeração igual à do lockout.
    expect(deOutraLoja.json.error).toEqual(idQueNaoExiste.json.error);
  });

  it("usuário legado (store_id NULL) loga só na loja default", async () => {
    const naDefault = await login(USER_LEGADO, "3333");
    expect(naDefault.status).toBe(200);

    const naLojaBRes = await login(USER_LEGADO, "3333", naLojaB);
    expect(naLojaBRes.status).toBe(401);
  });

  it("tentativa cross-store conta pro lockout (5 erros travam a conta)", async () => {
    const id = "u-loja-b-lock";
    await criaUsuario(id, "Lia Loja B", LOJA_B, "4444");

    for (let i = 0; i < 5; i++) {
      const tentativa = await login(id, "4444"); // contexto da loja A
      expect(tentativa.status).toBe(401);
      expect(tentativa.json.error.code).toBe("invalid_credentials");
    }

    const conta = await raw.get(`SELECT failed_attempts, locked_until FROM "user" WHERE id = $1`, [id]);
    expect(conta.failed_attempts).toBeGreaterThanOrEqual(5);
    expect(conta.locked_until).toBeTruthy();

    // Continua genérico: nem com o PIN certo (na loja certa) a resposta
    // revela que a conta existe e está bloqueada.
    const naSuaLoja = await login(id, "4444", naLojaB);
    expect(naSuaLoja.status).toBe(401);
    expect(naSuaLoja.json.error.code).toBe("invalid_credentials");
  });
});
