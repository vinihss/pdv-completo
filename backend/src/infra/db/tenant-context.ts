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
import { isSafeSchemaName } from "../../domain/tenant.js";

export type TenantScope = {
  /** Nome do schema Postgres que o processo fala para esta requisição. */
  schemaName: string;
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
 * O schema que o `db` deve usar agora.
 *
 * Prioridade:
 *  1. ALS (request ativo) → o schema do tenant;
 *  2. `DEFAULT_TENANT_SCHEMA` do ambiente (comportamento de pré-Fase 2);
 *  3. `public`.
 *
 * `TENANT_STRICT=1` inverte a decisão no item 2: sem ALS e sem env, lança
 * em vez de cair no default — o modo estrito é a garantia de que nenhum
//  código novo "esqueceu" de rodar dentro de um escopo de tenant.
 */
export function resolveTenantSchemaInScope(): string {
  const scope = currentTenantScope();
  if (scope) return scope.schemaName;

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
