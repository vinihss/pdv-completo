// Contexto de tenant via AsyncLocalStorage (ALS) — Fase 2 do
// `docs/15-multi-tenant-schema.md` §4.1/§4.2.
//
// O ALS é o TRANSPORTE do tenant (quem diz "esta requisição é da loja X");
// o pool dedicado por tenant (`tenant-db.ts`) é a BARREIRA de isolamento.
// Sem os dois, um `SET search_path` de sessão votaria na mesma conexão e
// vazaria entre requisições no keep-alive (§4.2).
//
// Quem popula: o `onRequest` do Fastify (`server.ts`), chamando
// `resolveTenantSchemaInScope()` — a seam de storage já lê daqui.
// Quem consome: o Proxy de `db` em `client.ts`, e a seam de storage.
import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_TENANT_ID, isSafeSchemaName } from "../../domain/tenant.js";

export type TenantScope = {
  /** Id do tenant (uuid) — a identidade estável, vai para `app.tenant_id`. */
  tenantId: string;
  /** Slug do tenant (ex.: "umami", "pdv1"). Necessário para JWT e validação. */
  slug: string;
  /** `true` quando veio do ambiente (apex/localhost/kill-switch). */
  isDefault: boolean;
};

const store = new AsyncLocalStorage<TenantScope | undefined>();

/** Entrar com um escopo de tenant. Use `enterTenantScope` para rodar código dentro dele. */
export function enterTenantScope(scope: TenantScope): void {
  store.enterWith(scope);
}

/**
 * Limpa o escopo atual. Usado pelo hook `onResponse` do Fastify para o ALS
 * não vazar a loja do request anterior para o código que roda depois
 * (inclusive testes que injetam vários requests no mesmo contexto async).
 */
export function exitTenantScope(): void {
  store.enterWith(undefined);
}

/** Roda `cb` dentro de um escopo de tenant, isolado do escopo externo. */
export async function runInTenantScope<T>(scope: TenantScope, cb: () => Promise<T>): Promise<T> {
  return store.run(scope, cb);
}

/** Devolve o escopo atual, ou `undefined` quando não há request no ar. */
export function currentTenantScope(): TenantScope | undefined {
  return store.getStore();
}

/**
 * O schema que o `db` deve usar agora: **sempre `public`**.
 *
 * No modelo por LINHA (`docs/28`) todas as lojas moram no mesmo schema — o
 * que separa uma da outra é a coluna `tenant_id` + a policy de RLS (a Fase
 * 2). O roteamento por schema (o `docs/15`) acabou: sobrou o
 * `DEFAULT_TENANT_SCHEMA` do ambiente, que é topologia de operação (o schema
 * default do dono do volume), não do tenant.
 */
export function resolveTenantSchemaInScope(): string {
  const scope = currentTenantScope();
  if (scope) return "public";

  const fromEnv = process.env.DEFAULT_TENANT_SCHEMA?.trim();
  if (fromEnv && isSafeSchemaName(fromEnv)) return fromEnv;

  const strict = (process.env.TENANT_STRICT ?? "").trim().toLowerCase();
  if (strict === "1" || strict === "true" || strict === "yes" || strict === "on") {
    throw new Error(
      "[tenant] acesso ao db fora de um escopo de tenant (TENANT_STRICT=1). " +
        "Cada handler precisa entrar no ALS via tenant.middleware, ou o DEFAULT_TENANT_SCHEMA precisa estar definido.",
    );
  }
  return "public";
}

/** `true` quando o ALS tem um escopo ativo (request multi-tenant no ar). */
export function hasTenantScope(): boolean {
  return currentTenantScope() !== undefined;
}

/**
 * O id do tenant do contexto corrente.
 *
 * É a chave de TUDO que precisa separar uma loja da outra: o pool (o
 * `app.tenant_id` do startup packet), a chave do cache e o `set_config` da
 * transação. Sem ALS (jobs, seed), é o default implícito.
 */
export function currentTenantId(): string {
  return currentTenantScope()?.tenantId ?? DEFAULT_TENANT_ID;
}

/**
 * Workaround para problema de propagação do ALS no Fastify.
 * Garante que o tenant scope esteja ativo antes de executar uma função.
 * Se o ALS já está ativo, executa a função diretamente.
 * Caso contrário, resolve o tenant pelo host e usa store.run() para garantir propagação.
 */
export async function ensureTenantScope<T>(
  host: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (currentTenantScope()) {
    return fn();
  }
  // Importação dinâmica para evitar ciclo de dependência
  const { resolveTenant } = await import("../composition/default-usecases.js");
  const tenant = await resolveTenant(host);
  return store.run(
    {
      tenantId: tenant.id,
      slug: tenant.slug,
      isDefault: tenant.isDefault,
    },
    fn
  );
}
