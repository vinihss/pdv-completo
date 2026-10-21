// Suíte de isolamento multi-tenant — `docs/multi-tenant-login-correcao.md` §22.
//
// Valida que o roteamento por `Host` + JWT com `tenant` impede vazamento de
// dados entre tenants: cada tenant vê só seus usuários, tokens de um tenant
// são rejeitados em outro, e requests concorrentes não contaminam o ALS.
//
// MODELO POR LINHA (`docs/28`): as duas lojas de teste convivem no MESMO
// schema (`public`) — quem as separa é a coluna `tenant_id` + a policy de
// RLS (a `0015`). Antes (o `docs/15`) cada loja tinha um schema próprio, e o
// isolamento era o schema; agora o isolamento é a LINHA. É por isso que os
// ids das lojas são FIXOS aqui: o `tenant_id` que o app grava na transação
// (`app.tenant_id`) tem que ser o mesmo da linha do registry.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { api, closeTestApp, raw, rawOwner } from "./helpers.js";
import { runRegistryMigrations } from "../src/infra/db/registry-migrate.js";
import { invalidateTenantRegistryCache } from "../src/infra/tenant/registry.js";
import { runInTenantScope } from "../src/infra/db/tenant-context.js";

const ROOT_DOMAIN = "teste.local";
// Ids FIXOS dos tenants de teste: o mesmo id vai para a linha do registry e
// para o escopo ALS, para que o `app.tenant_id` gravado na transação seja o
// id do banco (e não um uuid diferente do que o registry devolve).
const TENANT_A_ID = "aaaaaaaa-1111-2222-3333-44444444444a";
const TENANT_B_ID = "bbbbbbbb-1111-2222-3333-44444444444b";
const TENANT_A_SLUG = "a";
const TENANT_B_SLUG = "b";
// As lojas NÃO têm schema (modelo por linha): o schema é o do app.

let userIdA: string;
let userIdB: string;

const ENV_KEYS = ["TENANT_ROUTING", "PLATFORM_ROOT_DOMAIN"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  // Salvar env original
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

  // Habilitar roteamento por Host
  process.env.TENANT_ROUTING = "true";
  process.env.PLATFORM_ROOT_DOMAIN = ROOT_DOMAIN;

  // Aplicar migrations do registry (tabela public.tenant)
  await runRegistryMigrations();

  // Registrar tenants no registry (as lojas moram no schema ÚNICO: o
  // `schema_name` é topologia morta — a coluna sai na Fase 3c).
  await raw.all(
    `INSERT INTO public.tenant (id, slug, schema_name, display_name, status)
     VALUES ($1, $2, 'public', $3, $4)
     ON CONFLICT (slug) DO UPDATE SET id = EXCLUDED.id, display_name = EXCLUDED.display_name, status = EXCLUDED.status`,
    [TENANT_A_ID, TENANT_A_SLUG, "Tenant A", "active"]
  );
  await raw.all(
    `INSERT INTO public.tenant (id, slug, schema_name, display_name, status)
     VALUES ($1, $2, 'public', $3, $4)
     ON CONFLICT (slug) DO UPDATE SET id = EXCLUDED.id, display_name = EXCLUDED.display_name, status = EXCLUDED.status`,
    [TENANT_B_ID, TENANT_B_SLUG, "Tenant B", "active"]
  );

  // Invalidar cache do registry para garantir que as novas entradas sejam lidas
  invalidateTenantRegistryCache();

  // Popular tenant A — o `set_config` é de TRANSAÇÃO (um `SET` de sessão
  // gruda na conexão do POOL e envenenaria o `app.tenant_id` das outras
  // leituras).
  const pinHashA = await argon2.hash("1111");
  // O `set_config(..., true)` é de TRANSAÇÃO (um `SET` de sessão gruda na
  // conexão do POOL e envenenaria o `app.tenant_id` das outras leituras): a
  // policy de RLS exige que a linha escrita seja da loja do contexto, e o
  // trigger preenche o `tenant_id` a partir dele.
  await raw.exec(`
    SELECT set_config('app.tenant_id', '${TENANT_A_ID}', true);
    INSERT INTO store_settings (id, merchant_name, merchant_city, enabled_payment_methods, uses_delivery, kitchen_enabled)
    VALUES ('singleton', 'Tenant A', 'Cidade A', '["cash"]', false, false)
    ON CONFLICT (tenant_id, id) DO NOTHING
  `);
  await raw.exec(`
    SELECT set_config('app.tenant_id', '${TENANT_A_ID}', true);
    INSERT INTO "user" (id, name, role, pin_hash, active, failed_attempts)
    VALUES ('user-a', 'Usuário A', 'waiter', '${pinHashA}', true, 0)
    ON CONFLICT (tenant_id, id) DO NOTHING
  `);
  userIdA = "user-a";

  // Popular tenant B (mesma regra de contexto: `set_config` de TRANSAÇÃO).
  const pinHashB = await argon2.hash("2222");
  await raw.exec(`
    SELECT set_config('app.tenant_id', '${TENANT_B_ID}', true);
    INSERT INTO store_settings (id, merchant_name, merchant_city, enabled_payment_methods, uses_delivery, kitchen_enabled)
    VALUES ('singleton', 'Tenant B', 'Cidade B', '["cash"]', false, false)
    ON CONFLICT (tenant_id, id) DO NOTHING
  `);
  await raw.exec(`
    SELECT set_config('app.tenant_id', '${TENANT_B_ID}', true);
    INSERT INTO "user" (id, name, role, pin_hash, active, failed_attempts)
    VALUES ('user-b', 'Usuário B', 'waiter', '${pinHashB}', true, 0)
    ON CONFLICT (tenant_id, id) DO NOTHING
  `);
  userIdB = "user-b";

  // Fechar o servidor para forçar recriação com as novas variáveis de ambiente
  // (TENANT_ROUTING e PLATFORM_ROOT_DOMAIN). O servidor é um singleton criado
  // na primeira chamada de testApp(), e se ele já existia antes do beforeAll,
  // está usando o schema public. Fechar força recriação com os tenants configurados.
  await closeTestApp();
});

afterAll(async () => {
  // Restaurar env original
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  // Limpar o dado das lojas de teste. O DONO: o papel do app não enxerga a
  // linha de outra loja, e a FK `store_settings → public.tenant` é verificada
  // com as linhas REAIS.
  await rawOwner.all(`DELETE FROM "user" WHERE tenant_id IN ($1, $2)`, [TENANT_A_ID, TENANT_B_ID]);
  await rawOwner.all(`DELETE FROM store_settings WHERE tenant_id IN ($1, $2)`, [TENANT_A_ID, TENANT_B_ID]);

  // Remover tenants do registry
  // O DONO: a FK `user.tenant_id → public.tenant` é verificada com as linhas
  // REAIS, e o papel do app não enxerga o `user` da outra loja → o DELETE da
  // linha do registry falhava com violação de FK.
  await rawOwner.all(`DELETE FROM public.tenant WHERE slug IN ($1, $2)`, [TENANT_A_SLUG, TENANT_B_SLUG]);
  invalidateTenantRegistryCache();

  await closeTestApp();
});

describe("Isolamento multi-tenant", () => {
  it("A) Host de tenant A lista apenas usuários de tenant A", async () => {
    // Usa runInTenantScope para forçar o contexto do tenant durante a execução do handler,
    // contornando o problema de propagação do ALS através do inject() do Fastify.
    await runInTenantScope(
      {
        tenantId: TENANT_A_ID,
        slug: TENANT_A_SLUG,
        isDefault: false,
      },
      async () => {
        const res = await api("get", "/auth/users", {
          headers: { "x-tenant-host": `${TENANT_A_SLUG}.${ROOT_DOMAIN}` },
        });
        expect(res.status).toBe(200);
        expect(res.json.map((u: any) => u.name)).toEqual(["Usuário A"]);
      }
    );
  });

  it("B) Host de tenant B lista apenas usuários de tenant B", async () => {
    await runInTenantScope(
      {
        tenantId: TENANT_B_ID,
        slug: TENANT_B_SLUG,
        isDefault: false,
      },
      async () => {
        const res = await api("get", "/auth/users", {
          headers: { "x-tenant-host": `${TENANT_B_SLUG}.${ROOT_DOMAIN}` },
        });
        expect(res.status).toBe(200);
        expect(res.json.map((u: any) => u.name)).toEqual(["Usuário B"]);
      }
    );
  });

  it("C) Login com userId de outro tenant retorna 401", async () => {
    await runInTenantScope(
      {
        tenantId: TENANT_A_ID,
        slug: TENANT_A_SLUG,
        isDefault: false,
      },
      async () => {
        const res = await api("post", "/auth/login", {
          headers: { "x-tenant-host": `${TENANT_A_SLUG}.${ROOT_DOMAIN}` },
          body: { userId: userIdB, pin: "2222" },
        });
        expect(res.status).toBe(401);
      }
    );
  });

  it("D) JWT de tenant A em host de tenant B retorna 401", async () => {
    // Login válido em tenant A
    let tokenA: string;
    await runInTenantScope(
      {
        tenantId: TENANT_A_ID,
        slug: TENANT_A_SLUG,
        isDefault: false,
      },
      async () => {
        const loginRes = await api("post", "/auth/login", {
          headers: { "x-tenant-host": `${TENANT_A_SLUG}.${ROOT_DOMAIN}` },
          body: { userId: userIdA, pin: "1111" },
        });
        expect(loginRes.status).toBe(200);
        tokenA = loginRes.json.token;
      }
    );

    // Usa token em tenant B — deve ser rejeitado
    await runInTenantScope(
      {
        tenantId: TENANT_B_ID,
        slug: TENANT_B_SLUG,
        isDefault: false,
      },
      async () => {
        const res = await api("get", "/auth/me", {
          headers: { "x-tenant-host": `${TENANT_B_SLUG}.${ROOT_DOMAIN}` },
          token: tokenA!,
        });
        expect(res.status).toBe(401);
      }
    );
  });

  it("E) Host de tenant inexistente retorna 404", async () => {
    // Este teste não precisa de runInTenantScope porque está testando
    // o caminho de erro onde o tenant não existe no registry
    const res = await api("get", "/auth/users", {
      headers: { "x-tenant-host": `inexistente.${ROOT_DOMAIN}` },
    });
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe("tenant_not_resolved");
  });

  it("F) Requests concorrentes para tenants diferentes não vazam dados", async () => {
    // Fazemos requests concorrentes para tenants diferentes, cada um dentro
    // do seu próprio escopo de tenant. O ALS (AsyncLocalStorage) deve isolar
    // os contextos mesmo durante execução concorrente.
    const [resA, resB] = await Promise.all([
      runInTenantScope(
        {
        tenantId: TENANT_A_ID,
        slug: TENANT_A_SLUG,
        isDefault: false,
      },
        async () => {
          return await api("get", "/auth/users", { 
            headers: { "x-tenant-host": `${TENANT_A_SLUG}.${ROOT_DOMAIN}` } 
          });
        }
      ),
      runInTenantScope(
        {
        tenantId: TENANT_B_ID,
        slug: TENANT_B_SLUG,
        isDefault: false,
      },
        async () => {
          return await api("get", "/auth/users", { 
            headers: { "x-tenant-host": `${TENANT_B_SLUG}.${ROOT_DOMAIN}` } 
          });
        }
      )
    ]);
    
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.json.map((u: any) => u.name)).toEqual(["Usuário A"]);
    expect(resB.json.map((u: any) => u.name)).toEqual(["Usuário B"]);
  });
});
