export { MemoryCache } from "./memory-cache.js";
export type { ICacheClient, CacheEntry, CacheOptions } from "./cache-client.js";

import { MemoryCache } from "./memory-cache.js";
import { ICacheClient, CacheOptions } from "./cache-client.js";
import { resolveTenantSchemaInScope } from "../db/tenant-context.js";

let instance: ICacheClient | null = null;

/**
 * O singleton de cache do processo. É GLOBAL — as chaves cruas NÃO são
 * particionadas. Quem guarda dado de tenant deve usar `tenantCache`, que
 * prefixa a chave com o schema corrente; quem guarda dado de plataforma
 * (ex.: o registry `public.tenant`) usa este acesso direto de propósito.
 */
export function getCache(): ICacheClient {
  if (!instance) {
    instance = new MemoryCache();
  }
  return instance;
}

export function resetCache(): void {
  if (instance) {
    instance.clear();
  }
  instance = null;
}

/**
 * Cache PARTICIONADO por schema de tenant.
 *
 * O `getCache()` é um singleton por PROCESSO, e o processo serve vários
 * tenants por Host (multi-tenant por schema, `docs/15`). Sem partição, a
 * primeira loja a popular uma chave fixa (`store-settings`, `public-menu`…)
 * serviria a outra por até o TTL. Aqui toda chave de dado de tenant é
 * prefixada com `${schema}:` — o mesmo schema que o ALS resolve para a
 * requisição (`resolveTenantSchemaInScope`), e o `invalidatePattern` usa o
 * mesmo prefixo, de modo que `products:*` vira `${schema}:products:*`.
 *
 * Não é um wrapper de `ICacheClient` "com estado": o schema é lido a CADA
 * operação, então o mesmo objeto vale para qualquer escopo — o do request
 * (`store.run`) ou o de um worker que itera tenants (`runInTenantScope`).
 *
 * O que NÃO usar aqui: o registry de tenants (`infra/tenant/registry.ts`),
 * que vive em `public` e é global entre todas as lojas.
 */
function scopedKey(key: string): string {
  return `${resolveTenantSchemaInScope()}:${key}`;
}

export const tenantCache = {
  get<T>(key: string): T | null {
    return getCache().get<T>(scopedKey(key));
  },
  set<T>(key: string, value: T, options?: CacheOptions): void {
    getCache().set<T>(scopedKey(key), value, options);
  },
  invalidate(key: string): void {
    getCache().invalidate(scopedKey(key));
  },
  invalidatePattern(pattern: string): void {
    getCache().invalidatePattern(scopedKey(pattern));
  },
};
