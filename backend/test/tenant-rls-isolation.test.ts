// A suíte de isolamento por LINHA (RLS) — workstream B (`docs/28`).
//
// A suíte de `tenant-isolation.test.ts` prova o isolamento do modelo
// schema-por-tenant (um schema por loja, o pool dedicado). Esta prova o do
// modelo **por linha**: dois tenants no **mesmo** schema, e a policy do
// Postgres decidindo o que cada sessão enxerga.
//
// A diferença que importa: no schema-por-tenant, o isolamento é estrutural — o
// pool do tenant A só conversa com o schema A, e é impossível vazar. No modelo
// por linha, o isolamento é uma policy: `tenant_id =
// current_setting('app.tenant_id')`. Se a policy (ou o papel) estiver errado,
// o vazamento é silencioso — e é por isso que esta suíte existe.
//
// O que ela prova:
//   1. a loja A não vê os dados da loja B (e o contrário) — pela policy, com
//      as duas lojas no MESMO schema;
//   2. sem contexto de tenant a query **falha** (fail-closed) em vez de
//      devolver vazio — porque "vazio" é indistinguível de "a loja não tem
//      esse dado", e o app trata os dois igual;
//   3. a escrita fora do contexto é recusada (`WITH CHECK`).
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, closeTestApp, raw } from "./helpers.js";
import { runRegistryMigrations } from "../src/infra/db/registry-migrate.js";
import { invalidateTenantRegistryCache } from "../src/infra/tenant/registry.js";

const ROOT_DOMAIN = "rls.local";
// Ids FIXOS: o mesmo id vai para a linha do registry e para a coluna
// `tenant_id` das linhas — o que a policy compara com o `app.tenant_id`.
const TENANT_A_ID = "cccccccc-1111-2222-3333-44444444444a";
const TENANT_B_ID = "dddddddd-1111-2222-3333-44444444444b";
const TENANT_A_SLUG = "linha-a";
const TENANT_B_SLUG = "linha-b";

const ENV_KEYS = ["TENANT_ROUTING", "PLATFORM_ROOT_DOMAIN"] as const;
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.TENANT_ROUTING = "true";
  process.env.PLATFORM_ROOT_DOMAIN = ROOT_DOMAIN;

  await runRegistryMigrations();

  // As DUAS lojas no MESMO schema (`public`): é o modelo por linha — a
  // separação é a coluna `tenant_id`, não o schema.
  await raw.all(
    `INSERT INTO public.tenant (id, slug, schema_name, display_name, status)
     VALUES ($1, $2, 'public', $3, 'active')
     ON CONFLICT (slug) DO UPDATE SET id = EXCLUDED.id, display_name = EXCLUDED.display_name`,
    [TENANT_A_ID, TENANT_A_SLUG, "Loja A"],
  );
  await raw.all(
    `INSERT INTO public.tenant (id, slug, schema_name, display_name, status)
     VALUES ($1, $2, 'public', $3, 'active')
     ON CONFLICT (slug) DO UPDATE SET id = EXCLUDED.id, display_name = EXCLUDED.display_name`,
    [TENANT_B_ID, TENANT_B_SLUG, "Loja B"],
  );
  invalidateTenantRegistryCache();

  // Um usuário por loja, cada um com o `tenant_id` da SUA loja. O `pin_hash`
  // não importa aqui: a suíte não autentica, ela lista.
  // O `SET` é da MESMA sessão do INSERT: a policy (`WITH CHECK`) exige que a
  // linha escrita seja da loja da sessão — sem o contexto, o insert é recusado
  // ("new row violates row-level security policy").
  await raw.all(
    `SET app.tenant_id = '${TENANT_A_ID}';
     INSERT INTO "user" (id, name, role, pin_hash, active, failed_attempts, tenant_id)
     VALUES ('rls-user-a', 'Usuário A', 'waiter', 'x', true, 0, '${TENANT_A_ID}')
     ON CONFLICT (id) DO NOTHING`,
  );
  await raw.all(
    `SET app.tenant_id = '${TENANT_B_ID}';
     INSERT INTO "user" (id, name, role, pin_hash, active, failed_attempts, tenant_id)
     VALUES ('rls-user-b', 'Usuário B', 'waiter', 'x', true, 0, '${TENANT_B_ID}')
     ON CONFLICT (id) DO NOTHING`,
  );

  await closeTestApp();
});

afterAll(async () => {
  // O DELETE também é filtrado pela policy: cada linha é apagada no contexto
  // da SUA loja (o `public.tenant` é o registry — sem policy, apaga direto).
  await raw.all(
    `SET app.tenant_id = '${TENANT_A_ID}'; DELETE FROM "user" WHERE id = 'rls-user-a'`,
  );
  await raw.all(
    `SET app.tenant_id = '${TENANT_B_ID}'; DELETE FROM "user" WHERE id = 'rls-user-b'`,
  );
  await raw.all(`DELETE FROM public.tenant WHERE slug IN ($1, $2)`, [TENANT_A_SLUG, TENANT_B_SLUG]);
  invalidateTenantRegistryCache();
  for (const key of ENV_KEYS) setEnv(key, savedEnv.get(key));
  await closeTestApp();
});

describe("isolamento por linha (RLS)", () => {
  it("a loja A lista só os usuários da loja A", async () => {
    const res = await api("get", "/auth/users", {
      headers: { "x-tenant-host": `${TENANT_A_SLUG}.${ROOT_DOMAIN}` },
    });
    expect(res.status).toBe(200);
    const nomes = res.json.map((u: { name: string }) => u.name);
    expect(nomes).toContain("Usuário A");
    expect(nomes).not.toContain("Usuário B");
  });

  it("a loja B lista só os usuários da loja B", async () => {
    const res = await api("get", "/auth/users", {
      headers: { "x-tenant-host": `${TENANT_B_SLUG}.${ROOT_DOMAIN}` },
    });
    expect(res.status).toBe(200);
    const nomes = res.json.map((u: { name: string }) => u.name);
    expect(nomes).toContain("Usuário B");
    expect(nomes).not.toContain("Usuário A");
  });

  it("sem contexto de tenant a query FALHA (fail-closed), não devolve vazio", async () => {
    // Uma conexão nova, sem o `app.tenant_id` do pool: é a policy que precisa
    // barrar. Um vazio silencioso seria indistinguível de "a loja não tem
    // esse dado" — e o app trata os dois igual.
    // O `DATABASE_URL` que o global-setup define é o do PAPEL RESTRITO (sem
    // superuser) — é o que torna a policy barreira de verdade. E a conexão é
    // NOVA: o GUC do pool não está nela.
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL/DATABASE_URL não definidas");
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await expect(client.query(`SELECT count(*) FROM "user"`)).rejects.toThrow(/app\.tenant_id/);
    } finally {
      await client.end();
    }
  });

  it("a escrita fora do contexto é recusada (WITH CHECK)", async () => {
    // O `DATABASE_URL` que o global-setup define é o do PAPEL RESTRITO (sem
    // superuser) — é o que torna a policy barreira de verdade. E a conexão é
    // NOVA: o GUC do pool não está nela.
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL/DATABASE_URL não definidas");
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO "user" (id, name, role, pin_hash, active, failed_attempts, tenant_id)
           VALUES ('rls-user-x', 'Usuário X', 'waiter', 'x', true, 0, $1)`,
          [TENANT_A_ID],
        ),
      ).rejects.toThrow(/app\.tenant_id|row-level security/i);
    } finally {
      await client.end();
    }
  });
});
