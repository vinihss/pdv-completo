// Fase 1 do multi-tenant (`docs/15-multi-tenant-schema.md` §6): registry
// `public.tenant`, resolução `Host` → loja e o endpoint que a vitrine de pedidos
// consome (`apps/pedido-public`).
//
// A suíte é dividida nas três peças que precisam ser provadas separadamente:
//   1. as REGRAS de `Host` (subdomínio, domínio próprio, apex, reservado,
//      slug inválido, kill-switch) — que é onde mora a regressão de segurança;
//   2. o CONTRATO do endpoint que a SPA consome (inclusive o que NÃO sai);
//   3. o REGISTRY (as migrations não vazam para dentro de um schema de tenant, e
//      o cache não vira resposta congelada).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api, closeTestApp, raw, resetState, seedFixture, testApp } from "./helpers.js";
import { pool } from "../src/infra/db/client.js";
import { runRegistryMigrations } from "../src/infra/db/registry-migrate.js";
import { runMigrations } from "../src/infra/db/migrate.js";
import {
  findTenantByCustomDomain,
  findTenantBySlug,
  invalidateTenantRegistryCache,
} from "../src/infra/tenant/registry.js";
import {
  DEFAULT_TENANT_SLUG,
  getPublicTenantUsecase,
  resolveTenant,
} from "../src/application/tenant/resolve-tenant.usecase.js";
import { matchTenantHost, normalizeTenantHost } from "../src/domain/tenant.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_SQL = path.resolve(__dirname, "../migrations/registry/0001_tenant_registry.sql");

const ROOT_DOMAIN = "seudominio.com.br";

type RegistryRow = {
  slug: string;
  schemaName: string;
  displayName?: string;
  status?: "active" | "suspended";
  customDomain?: string | null;
};

// O rate limit de lookup público é por IP (20/min), e a suíte chama o endpoint
// várias vezes: cada teste entra com um IP próprio, senão eles se bloqueiam
// (mesma técnica de `self-service.test.ts`).
let ipSeq = 0;
const nextIp = () => `203.0.113.${(ipSeq += 1)}`;

const ENV_KEYS = [
  "TENANT_ROUTING",
  "PLATFORM_ROOT_DOMAIN",
  "DEFAULT_TENANT_SCHEMA",
  "TENANT_REGISTRY_CACHE_TTL_SECONDS",
] as const;
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function seedRegistry(rows: RegistryRow[]): Promise<void> {
  await raw.exec("DELETE FROM public.tenant");
  for (const row of rows) {
    await raw.all(
      `INSERT INTO public.tenant (slug, schema_name, display_name, status, custom_domain)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.slug, row.schemaName, row.displayName ?? row.slug, row.status ?? "active", row.customDomain ?? null],
    );
  }
  invalidateTenantRegistryCache();
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  await seedFixture();
  // O registry tem runner próprio (`npm run db:migrate:registry`) e o global
  // setup só aplica `migrations/*.sql` — então a suíte o aplica, como o boot faz.
  await runRegistryMigrations();
});

afterAll(async () => {
  await raw.exec("DELETE FROM public.tenant");
  invalidateTenantRegistryCache();
  for (const key of ENV_KEYS) setEnv(key, savedEnv.get(key));
  await closeTestApp();
});

beforeEach(async () => {
  // Default do ambiente = Fase 1 desligada, sem domínio da plataforma, schema
  // `public`, TTL padrão.
  for (const key of ENV_KEYS) setEnv(key, undefined);
  await resetState();
  await seedRegistry([]);
});

// Liga o roteamento por `Host` no mesmo par que o deploy vai ter:
// `TENANT_ROUTING=true` + o `${ROOT_DOMAIN}` do Caddy.
function routingOn(rootDomain: string = ROOT_DOMAIN): void {
  setEnv("TENANT_ROUTING", "true");
  setEnv("PLATFORM_ROOT_DOMAIN", rootDomain);
}

// ---------------------------------------------------------------------------
// 1. As regras de `Host`
// ---------------------------------------------------------------------------
describe("tenant: resolução por Host", () => {
  it("subdomínio resolve pela 1ª label", async () => {
    routingOn();
    await seedRegistry([{ slug: "pdv1", schemaName: "tenant_pdv1" }]);

    expect(await resolveTenant("pdv1.seudominio.com.br")).toEqual({
      slug: "pdv1",
      schemaName: "tenant_pdv1",
      isDefault: false,
    });
  });

  it("domínio próprio resolve pelo `custom_domain` (e não pela 1ª label)", async () => {
    routingOn();
    // `umamisushiarte.com.br` tem 3 rótulos: sem a coluna de domínio próprio a
    // regra da 1ª label procuraria `umamisushiarte`, que não é a loja.
    await seedRegistry([
      { slug: "umami", schemaName: "tenant_umami", customDomain: "umamisushiarte.com.br" },
    ]);

    expect(await resolveTenant("umamisushiarte.com.br")).toEqual({
      slug: "umami",
      schemaName: "tenant_umami",
      isDefault: false,
    });
  });

  it("host é normalizado antes de casar: maiúsculas, porta e ponto final", async () => {
    routingOn();
    await seedRegistry([
      { slug: "umami", schemaName: "tenant_umami", customDomain: "umamisushiarte.com.br" },
    ]);

    for (const host of ["UMAMISUSHIARTE.com.br", "umamisushiarte.com.br:443", "umamisushiarte.com.br."]) {
      expect((await resolveTenant(host)).slug).toBe("umami");
    }
  });

  it("apex, localhost e intranet caem no tenant default", async () => {
    routingOn();
    await seedRegistry([{ slug: "pdv1", schemaName: "tenant_pdv1" }]);

    for (const host of [ROOT_DOMAIN, "localhost", "localhost:5175", "intranet"]) {
      expect(await resolveTenant(host)).toEqual({
        slug: DEFAULT_TENANT_SLUG,
        schemaName: "public",
        isDefault: true,
      });
    }
  });

  it("sem PLATFORM_ROOT_DOMAIN vale a heurística de rótulos do §3.1", async () => {
    routingOn("");
    await seedRegistry([{ slug: "pdv1", schemaName: "tenant_pdv1" }]);

    // TLD de uma label: 2 rótulos é apex.
    expect((await resolveTenant("seudominio.tech")).isDefault).toBe(true);
    expect((await resolveTenant("pdv1.seudominio.tech")).slug).toBe("pdv1");
    // E o apex de um `.com.br` (3 rótulos) vira slug — que é a razão de a env
    // existir: em produção o domínio da plataforma tem TLD de duas labels.
    await expect(resolveTenant(ROOT_DOMAIN)).rejects.toMatchObject({ code: "tenant_not_resolved" });
  });

  it("DEFAULT_TENANT_SCHEMA do ambiente é o schema do default", async () => {
    routingOn();
    setEnv("DEFAULT_TENANT_SCHEMA", "tenant_default");

    expect((await resolveTenant(ROOT_DOMAIN)).schemaName).toBe("tenant_default");
  });

  it("www/app/api não são tenant: caem no default mesmo com linha no registry", async () => {
    routingOn();
    // O pior caso: alguém registra `app` (e o domínio próprio `app.…`) para
    // tomar a origem do app interno / da API.
    await seedRegistry([
      { slug: "app", schemaName: "tenant_app", customDomain: "app.seudominio.com.br" },
      { slug: "www", schemaName: "tenant_www", customDomain: "www.seudominio.com.br" },
    ]);

    for (const host of ["app.seudominio.com.br", "api.seudominio.com.br", "www.seudominio.com.br"]) {
      expect(await resolveTenant(host)).toEqual({
        slug: DEFAULT_TENANT_SLUG,
        schemaName: "public",
        isDefault: true,
      });
    }
  });

  // A regressão de segurança: host fora do `CHECK` do slug tem que ser 404, e
  // NUNCA o default (a "regra de ouro" do §4.8). Cair no default serviria a
  // loja errada para quem pediu a loja certa.
  it("slug inválido → tenant_not_resolved (404), nunca o default", async () => {
    routingOn();
    await seedRegistry([{ slug: "pdv1", schemaName: "tenant_pdv1" }]);

    const invalidos = [
      "-pdv1.seudominio.com.br", // começa com hífen
      "pdv_1.seudominio.com.br", // underscore não casa o CHECK
      "pdv1!.seudominio.com.br", // caractere que não existe em hostname
      "pdv1.seudominio.com.br/x", // path colado no host
      "pdv1..seudominio.com.br", // rótulo vazio
      "  ", // vazio
    ];
    for (const host of invalidos) {
      await expect(resolveTenant(host)).rejects.toMatchObject({ code: "tenant_not_resolved", status: 404 });
    }

    // E o default segue intacto: o host válido ao lado continua funcionando.
    expect((await resolveTenant("pdv1.seudominio.com.br")).slug).toBe("pdv1");
  });

  it("host que não é da plataforma nem domínio de loja → 404, não o default", async () => {
    routingOn();
    await seedRegistry([{ slug: "pdv1", schemaName: "tenant_pdv1" }]);

    for (const host of ["outra-loja.seudominio.com.br", "loja.exemplo.net", "127.0.0.1"]) {
      await expect(resolveTenant(host)).rejects.toMatchObject({ code: "tenant_not_resolved", status: 404 });
    }
  });

  it("TENANT_ROUTING desligado (ou ausente) força o default, ignorando o Host", async () => {
    await seedRegistry([
      { slug: "pdv1", schemaName: "tenant_pdv1", customDomain: "umamisushiarte.com.br" },
    ]);

    for (const valor of [undefined, "false", "0", "off", "no"]) {
      setEnv("TENANT_ROUTING", valor);
      setEnv("PLATFORM_ROOT_DOMAIN", ROOT_DOMAIN);
      expect(await resolveTenant("pdv1.seudominio.com.br")).toEqual({
        slug: DEFAULT_TENANT_SLUG,
        schemaName: "public",
        isDefault: true,
      });
      expect(await resolveTenant("umamisushiarte.com.br")).toEqual({
        slug: DEFAULT_TENANT_SLUG,
        schemaName: "public",
        isDefault: true,
      });
    }

    // Default do ambiente = desligado (Fase 1 é "comportamento idêntico ao de
    // hoje"): sem a env, nenhum host resolve para tenant.
    setEnv("TENANT_ROUTING", undefined);
    expect((await resolveTenant("pdv1.seudominio.com.br")).isDefault).toBe(true);
  });

  it("TENANT_ROUTING ligado no vocabulário do gate (1/true/yes/on)", async () => {
    setEnv("PLATFORM_ROOT_DOMAIN", ROOT_DOMAIN);
    await seedRegistry([{ slug: "pdv1", schemaName: "tenant_pdv1" }]);

    for (const valor of ["1", "true", "TRUE", " yes ", "on"]) {
      setEnv("TENANT_ROUTING", valor);
      expect((await resolveTenant("pdv1.seudominio.com.br")).slug).toBe("pdv1");
    }
  });

  it("tenant suspenso → 403 tenant_inactive", async () => {
    routingOn();
    await seedRegistry([{ slug: "pdv1", schemaName: "tenant_pdv1", status: "suspended" }]);

    await expect(resolveTenant("pdv1.seudominio.com.br")).rejects.toMatchObject({
      code: "tenant_inactive",
      status: 403,
    });
  });

  it("schema_name fora do padrão é recusado no código, não só pelo CHECK do banco", async () => {
    routingOn();
    // O `CHECK` do banco é a primeira barreira; aqui ela é removida de propósito
    // para provar que a segunda (código) existe — o nome do schema entra num
    // `search_path` na Fase 2, então uma linha corrompida não pode passar.
    await raw.exec("ALTER TABLE public.tenant DROP CONSTRAINT tenant_schema_name_check");
    try {
      await seedRegistry([{ slug: "pdv1", schemaName: "public; DROP TABLE public.tenant" }]);
      await expect(resolveTenant("pdv1.seudominio.com.br")).rejects.toMatchObject({
        code: "tenant_schema_unavailable",
        status: 503,
      });
    } finally {
      await raw.exec("DELETE FROM public.tenant");
      await raw.exec(
        "ALTER TABLE public.tenant ADD CONSTRAINT tenant_schema_name_check CHECK (schema_name ~ '^tenant_[a-z0-9_]+$')",
      );
    }
  });

  it("normalizeTenantHost rejeita o que não é hostname", () => {
    expect(normalizeTenantHost("PdV1.SeuDominio.com.BR:8080")).toBe("pdv1.seudominio.com.br");
    expect(normalizeTenantHost(undefined)).toBeNull();
    expect(normalizeTenantHost("pdv1.seudominio.com.br/../admin")).toBeNull();
    expect(normalizeTenantHost("a".repeat(254))).toBeNull();
  });

  it("classificação do host é pura e não depende do banco", () => {
    expect(matchTenantHost("pdv1.seudominio.com.br", ROOT_DOMAIN)).toEqual({ kind: "slug", slug: "pdv1" });
    expect(matchTenantHost(ROOT_DOMAIN, ROOT_DOMAIN)).toEqual({ kind: "default", reason: "apex" });
    expect(matchTenantHost("localhost:5175".split(":")[0], ROOT_DOMAIN)).toEqual({
      kind: "default",
      reason: "local",
    });
    expect(matchTenantHost("api.seudominio.com.br", ROOT_DOMAIN)).toEqual({ kind: "reserved" });
    expect(matchTenantHost("umamisushiarte.com.br", ROOT_DOMAIN)).toEqual({ kind: "invalid" });
  });
});

// ---------------------------------------------------------------------------
// 2. O endpoint que a SPA consome
// ---------------------------------------------------------------------------
describe("GET /public/tenants/resolve", () => {
  it("devolve exatamente o contrato do TenantProvider, sem o `schema`", async () => {
    await raw.all(
      `UPDATE store_settings SET merchant_name = 'Umami Sushi Arte', brand_color = '#0f766e',
        uses_delivery = true, kitchen_enabled = false WHERE id = 'singleton'`,
    );

    const res = await api("get", "/public/tenants/resolve?host=umamisushiarte.com.br", { ip: nextIp() });

    expect(res.status).toBe(200);
    expect(res.json.found).toBe(true);
    // As chaves são o contrato: `schema` (o `schema_name` do banco) NÃO sai —
    // é topologia interna e revelaria qual schema existe para cada loja.
    expect(Object.keys(res.json.tenant).sort()).toEqual([
      "kitchenEnabled",
      "logoUrl",
      "name",
      "primaryColor",
      "slug",
      "storeId",
      "usesDelivery",
    ]);
    expect(res.json.tenant).toEqual({
      storeId: DEFAULT_TENANT_SLUG,
      slug: DEFAULT_TENANT_SLUG,
      name: "Umami Sushi Arte",
      logoUrl: null,
      primaryColor: "#0f766e",
      usesDelivery: true,
      kitchenEnabled: false,
    });
  });

  it("404 com `found: false` quando o endereço não é loja nenhuma", async () => {
    routingOn();

    const res = await api("get", "/public/tenants/resolve?host=nao-existe.exemplo.com", { ip: nextIp() });

    expect(res.status).toBe(404);
    expect(res.json.found).toBe(false);
    expect(res.json.error.code).toBe("tenant_not_resolved");
    expect(res.json.tenant).toBeUndefined();
  });

  it("com o roteamento desligado (default da Fase 1) nenhum host dá 404", async () => {
    // É o que segura o ar enquanto o registry está vazio: a loja default atende
    // qualquer endereço, exatamente como antes do multi-tenant.
    const res = await api("get", "/public/tenants/resolve?host=qualquer.endereco.com", { ip: nextIp() });

    expect(res.status).toBe(200);
    expect(res.json.found).toBe(true);
  });

  it("aceita o host no header `X-Tenant-Host` quando não vem na query", async () => {
    const res = await api("get", "/public/tenants/resolve", {
      ip: nextIp(),
      headers: { "x-tenant-host": "umamisushiarte.com.br" },
    });

    expect(res.status).toBe(200);
    expect(res.json.found).toBe(true);
  });

  it("sem query e sem header, usa o host da requisição", async () => {
    const res = await api("get", "/public/tenants/resolve", {
      ip: nextIp(),
      headers: { host: ROOT_DOMAIN },
    });

    expect(res.status).toBe(200);
    expect(res.json.tenant.slug).toBe(DEFAULT_TENANT_SLUG);
  });

  it("o path não leva o prefixo `/api` (o Caddy faz o strip)", async () => {
    // A SPA pede `<VITE_API_BASE_URL>/public/tenants/resolve`; o `api.*` do Caddy
    // faz proxy sem mexer em path e o bloco `(site)` tira `/api`. O que o
    // backend registra é o path sem prefixo — igual a `/public/menu`.
    const instance = await testApp();
    expect(instance.hasRoute({ method: "GET", url: "/public/tenants/resolve" })).toBe(true);
    expect(instance.hasRoute({ method: "GET", url: "/api/public/tenants/resolve" })).toBe(false);
  });

  it("tenant cujo schema o processo não fala responde 503 (limite da Fase 1)", async () => {
    // Com o roteamento desligado (default), `resolveTenant` devolve o schema
    // default, então este caso só existe com o roteamento ligado. É o limite
    // honesto da Fase 1: um tenant em `tenant_x` não tem cardápio, carrinho nem
    // pedido neste processo — atender pela metade (logo de B, catálogo de A)
    // seria o vazamento do §5.2 de novo.
    routingOn();
    await seedRegistry([{ slug: "pdv1", schemaName: "tenant_pdv1" }]);

    const res = await api("get", "/public/tenants/resolve?host=pdv1.seudominio.com.br", { ip: nextIp() });

    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe("tenant_schema_unavailable");
  });

  it("o use case público é o mesmo contrato do endpoint", async () => {
    const tenant = await getPublicTenantUsecase("localhost");
    expect(tenant.slug).toBe(DEFAULT_TENANT_SLUG);
    expect(tenant.storeId).toBe(DEFAULT_TENANT_SLUG);
    expect(typeof tenant.name).toBe("string");
    expect("schema" in tenant).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. O registry: onde a migration roda e até onde o cache vale
// ---------------------------------------------------------------------------
describe("registry: migrations, isolamento de schema e cache", () => {
  it("o runner de tenant não enxerga `migrations/registry/`", async () => {
    await runRegistryMigrations();
    await runMigrations();

    const doTenant = (await raw.all("SELECT name FROM _migrations ORDER BY name")).map((r) => r.name);
    const doRegistry = (await raw.all("SELECT name FROM public._registry_migrations ORDER BY name")).map(
      (r) => r.name,
    );

    expect(doRegistry).toEqual(["0001_tenant_registry.sql"]);

    expect(doTenant).toEqual(["0001_init.sql", "0002_pagarme.sql", "0003_courier_location.sql", "0004_delivery_arrival_alert_sent.sql"]);
    // E o diretório existe de verdade — a exclusão não é por pasta vazia.
    expect(fs.existsSync(path.dirname(REGISTRY_SQL))).toBe(true);
  });

  it("a migration do registry não pode nascer dentro de um schema de tenant", async () => {
    // Executa o MESMO arquivo do registry numa conexão cujo `search_path` é um
    // schema de tenant: é o que aconteceria se o glob do runner de tenant
    // pegasse esta pasta na Fase 3. Como o DDL é qualificado (`public.`) e o
    // runner ainda fixa `SET LOCAL search_path = public`, a tabela tem que nascer
    // em `public` — e o `SET LOCAL` não pode sujar a sessão.
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS tenant_probe CASCADE");
      await client.query("CREATE SCHEMA tenant_probe");
      await client.query("SET search_path TO tenant_probe");

      await client.query("BEGIN");
      await client.query(fs.readFileSync(REGISTRY_SQL, "utf8"));
      await client.query("COMMIT");

      const onde = await client.query(
        `SELECT to_regclass('public.tenant') AS em_public,
                to_regclass('tenant_probe.tenant') AS em_probe,
                current_setting('search_path') AS search_path`,
      );
      expect(onde.rows[0].em_public).toBe("public.tenant");
      expect(onde.rows[0].em_probe).toBeNull();
      // A sessão voltou ao que era (`SET LOCAL` não vaza para a conexão devolvida
      // ao pool).
      expect(onde.rows[0].search_path).toBe("tenant_probe");
    } finally {
      await client.query("RESET search_path");
      client.release();
      await raw.exec("DROP SCHEMA IF EXISTS tenant_probe CASCADE");
    }
  });

  it("cache: a segunda resolução não vai ao banco, e a invalidação devolve o fresco", async () => {
    await seedRegistry([{ slug: "pdv1", schemaName: "tenant_pdv1", displayName: "Loja A" }]);

    expect((await findTenantBySlug("pdv1"))?.displayName).toBe("Loja A");

    // Mudança no banco que a resposta NÃO pode enxergar enquanto o cache vale.
    await raw.all("UPDATE public.tenant SET display_name = 'Loja B' WHERE slug = 'pdv1'");
    expect((await findTenantBySlug("pdv1"))?.displayName).toBe("Loja A");

    invalidateTenantRegistryCache();
    expect((await findTenantBySlug("pdv1"))?.displayName).toBe("Loja B");
  });

  it("cache: o TTL do registry é respeitado", async () => {
    await seedRegistry([
      { slug: "umami", schemaName: "tenant_umami", displayName: "Loja A", customDomain: "umamisushiarte.com.br" },
    ]);
    setEnv("TENANT_REGISTRY_CACHE_TTL_SECONDS", "0");

    expect((await findTenantByCustomDomain("umamisushiarte.com.br"))?.displayName).toBe("Loja A");

    await raw.all("UPDATE public.tenant SET display_name = 'Loja C' WHERE slug = 'umami'");
    await new Promise((r) => setTimeout(r, 5));
    expect((await findTenantByCustomDomain("umamisushiarte.com.br"))?.displayName).toBe("Loja C");
  });

  it("resultado negativo também é cacheado (subdomínio inexistente não vira query por request)", async () => {
    expect(await findTenantBySlug("ainda-nao-existe")).toBeNull();

    await raw.all(
      `INSERT INTO public.tenant (slug, schema_name, display_name) VALUES ('ainda-nao-existe', 'tenant_nova', 'Nova')`,
    );
    expect(await findTenantBySlug("ainda-nao-existe")).toBeNull();

    invalidateTenantRegistryCache();
    expect((await findTenantBySlug("ainda-nao-existe"))?.schemaName).toBe("tenant_nova");
  });

  it("os CHECKs do registry valem no banco", async () => {
    await expect(
      raw.all("INSERT INTO public.tenant (slug, schema_name, display_name) VALUES ('Slug Inválido', 'tenant_x', 'X')"),
    ).rejects.toThrow();
    await expect(
      raw.all("INSERT INTO public.tenant (slug, schema_name, display_name) VALUES ('outro', 'public', 'X')"),
    ).rejects.toThrow();
    // Domínio próprio com maiúscula não entra: o índice único é sobre `lower()`
    // e o `CHECK` exige a forma que o browser envia.
    await expect(
      raw.all(
        "INSERT INTO public.tenant (slug, schema_name, display_name, custom_domain) VALUES ('a', 'tenant_a', 'A', 'Loja.com.br')",
      ),
    ).rejects.toThrow();
    // E dois tenants não podem disputar o mesmo endereço.
    await seedRegistry([
      { slug: "a", schemaName: "tenant_a", customDomain: "loja.com.br" },
      { slug: "b", schemaName: "tenant_b" },
    ]);
    await expect(
      raw.all(
        "INSERT INTO public.tenant (slug, schema_name, display_name, custom_domain) VALUES ('b', 'tenant_b', 'B', 'loja.com.br')",
      ),
    ).rejects.toThrow();
  });
});
