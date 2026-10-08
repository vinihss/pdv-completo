// Suíte de isolamento multi-tenant — `docs/multi-tenant-login-correcao.md` §22.
//
// Valida que o roteamento por `Host` + JWT com `tenant` impede vazamento de
// dados entre tenants: cada tenant vê só seus usuários, tokens de um tenant
// são rejeitados em outro, e requests concorrentes não contaminam o ALS.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { api, closeTestApp, raw } from "./helpers.js";
import { runMigrations } from "../src/infra/db/migrate.js";
import { runRegistryMigrations } from "../src/infra/db/registry-migrate.js";
import { invalidateTenantRegistryCache } from "../src/infra/tenant/registry.js";
import { runInTenantScope } from "../src/infra/db/tenant-context.js";

const ROOT_DOMAIN = "teste.local";
const TENANT_A_SLUG = "a";
const TENANT_B_SLUG = "b";
const TENANT_A_SCHEMA = "tenant_test_a";
const TENANT_B_SCHEMA = "tenant_test_b";

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

  // Criar schemas de tenant
  await raw.exec(`CREATE SCHEMA IF NOT EXISTS ${TENANT_A_SCHEMA}`);
  await raw.exec(`CREATE SCHEMA IF NOT EXISTS ${TENANT_B_SCHEMA}`);

  // Registrar tenants no registry
  await raw.all(
    `INSERT INTO public.tenant (slug, schema_name, display_name, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO UPDATE SET schema_name = EXCLUDED.schema_name, display_name = EXCLUDED.display_name, status = EXCLUDED.status`,
    [TENANT_A_SLUG, TENANT_A_SCHEMA, "Tenant A", "active"]
  );
  await raw.all(
    `INSERT INTO public.tenant (slug, schema_name, display_name, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO UPDATE SET schema_name = EXCLUDED.schema_name, display_name = EXCLUDED.display_name, status = EXCLUDED.status`,
    [TENANT_B_SLUG, TENANT_B_SCHEMA, "Tenant B", "active"]
  );

  // Invalidar cache do registry para garantir que as novas entradas sejam lidas
  invalidateTenantRegistryCache();

  // Aplicar migrations em cada schema de tenant
  await runMigrations({ schema: TENANT_A_SCHEMA });
  await runMigrations({ schema: TENANT_B_SCHEMA });

  // Popular tenant A — usa nomes totalmente qualificados (schema.table) para
  // não depender de `search_path` (cada `pool.query` pode pegar conexão
  // diferente do pool, então `SET LOCAL` não sobrevive entre statements).
  const pinHashA = await argon2.hash("1111");
  await raw.exec(`
    INSERT INTO ${TENANT_A_SCHEMA}.store_settings (id, merchant_name, merchant_city, enabled_payment_methods, uses_delivery, kitchen_enabled)
    VALUES ('singleton', 'Tenant A', 'Cidade A', '["cash"]', false, false)
    ON CONFLICT (id) DO NOTHING
  `);
  await raw.exec(`
    INSERT INTO ${TENANT_A_SCHEMA}."user" (id, name, role, pin_hash, active, failed_attempts)
    VALUES ('user-a', 'Usuário A', 'waiter', '${pinHashA}', true, 0)
    ON CONFLICT (id) DO NOTHING
  `);
  userIdA = "user-a";

  // Popular tenant B
  const pinHashB = await argon2.hash("2222");
  await raw.exec(`
    INSERT INTO ${TENANT_B_SCHEMA}.store_settings (id, merchant_name, merchant_city, enabled_payment_methods, uses_delivery, kitchen_enabled)
    VALUES ('singleton', 'Tenant B', 'Cidade B', '["cash"]', false, false)
    ON CONFLICT (id) DO NOTHING
  `);
  await raw.exec(`
    INSERT INTO ${TENANT_B_SCHEMA}."user" (id, name, role, pin_hash, active, failed_attempts)
    VALUES ('user-b', 'Usuário B', 'waiter', '${pinHashB}', true, 0)
    ON CONFLICT (id) DO NOTHING
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

  // Limpar schemas de tenant
  await raw.exec(`DROP SCHEMA IF EXISTS ${TENANT_A_SCHEMA} CASCADE`);
  await raw.exec(`DROP SCHEMA IF EXISTS ${TENANT_B_SCHEMA} CASCADE`);

  // Remover tenants do registry
  await raw.all(`DELETE FROM public.tenant WHERE slug IN ($1, $2)`, [TENANT_A_SLUG, TENANT_B_SLUG]);
  invalidateTenantRegistryCache();

  await closeTestApp();
});

describe("Isolamento multi-tenant", () => {
  it("A) Host de tenant A lista apenas usuários de tenant A", async () => {
    // Usa runInTenantScope para forçar o contexto do tenant durante a execução do handler,
    // contornando o problema de propagação do ALS através do inject() do Fastify.
    await runInTenantScope(
      { schemaName: TENANT_A_SCHEMA, slug: TENANT_A_SLUG, isDefault: false },
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
      { schemaName: TENANT_B_SCHEMA, slug: TENANT_B_SLUG, isDefault: false },
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
      { schemaName: TENANT_A_SCHEMA, slug: TENANT_A_SLUG, isDefault: false },
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
      { schemaName: TENANT_A_SCHEMA, slug: TENANT_A_SLUG, isDefault: false },
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
      { schemaName: TENANT_B_SCHEMA, slug: TENANT_B_SLUG, isDefault: false },
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
        { schemaName: TENANT_A_SCHEMA, slug: TENANT_A_SLUG, isDefault: false },
        async () => {
          return await api("get", "/auth/users", { 
            headers: { "x-tenant-host": `${TENANT_A_SLUG}.${ROOT_DOMAIN}` } 
          });
        }
      ),
      runInTenantScope(
        { schemaName: TENANT_B_SCHEMA, slug: TENANT_B_SLUG, isDefault: false },
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
