import type { TenantCache } from "../../application/ports/effects.js";
import type { TenantContext } from "../../application/ports/tenant-context.js";
import { getCache, tenantCache } from "./index.js";
import type { ICacheClient } from "./cache-client.js";

/**
 * Adapter do port `TenantCache` (ports/effects.ts) — FASE 0 da refatoração.
 *
 * Diferença em relação ao `tenantCache` de `infra/cache/index.ts`: a
 * partição por loja aqui é por `tenant.tenantId` EXPLÍCITO, recebido no
 * construtor — sem depender do `AsyncLocalStorage` (seam
 * `currentTenantScope`). O use case migrado recebe o `TenantContext`
 * e instancia este adapter com ele; workers/webhooks fora de um request no ar
 * (onde o ALS não está populado) particionam corretamente por construção.
 *
 * O prefixo é `${tenantId}:` — o MESMO formato do `tenantCache` atual, então
 * as duas superfícies enxergam as mesmas chaves (nenhum warmup/invalidação
 * muda de significado durante a migração).
 *
 * POR QUE O ID E NÃO O SLUG: o slug é rótulo (pode ser renomeado) e o id é
 * identidade. E por que o TENANT e não o schema: no modelo por linha todas as
 * lojas moram no mesmo schema — particionar por schema misturaria as lojas
 * (o `active` de uma vazaria para a outra).
 */
export class TenantCacheAdapter implements TenantCache {
  private readonly prefix: string;
  private readonly cache?: ICacheClient;

  /**
   * @param tenant contexto do tenant (só o `tenantId` é usado)
   * @param cache cliente concreto; quando omitido, resolve `getCache()` POR
   *   CHAMADA — igual ao `tenantCache` atual, que lê a instância corrente do
   *   processo (`initCache()` pode trocar MemoryCache por Redis no boot, e um
   *   default avaliado na construção capturaria a instância errada).
   */
  constructor(tenant: Pick<TenantContext, "tenantId">, cache?: ICacheClient) {
    this.prefix = `${tenant.tenantId}:`;
    this.cache = cache;
  }

  private client(): ICacheClient {
    return this.cache ?? getCache();
  }

  async get<T>(key: string): Promise<T | null> {
    return this.client().get<T>(`${this.prefix}${key}`);
  }

  async set<T>(key: string, value: T, options?: { ttl?: number }): Promise<void> {
    await this.client().set<T>(`${this.prefix}${key}`, value, options);
  }

  /** Invalida todas as chaves sob o prefixo (`invalidatePattern("<prefixo>*")`). */
  async invalidatePrefix(prefix: string): Promise<void> {
    await this.client().invalidatePattern(`${this.prefix}${prefix}*`);
  }
}

/**
 * Adapter do port `TenantCache` que resolve o tenant do
 * **ALS a cada chamada** (não no construtor). É o equivalente
 * ao `tenantCache` de `infra/cache` (proxy que prefixa com o
 * schema corrente), mas falando a interface congelada do port —
 * para a composition root (`default-usecases`) injetar nos use
 * cases sem que a application importe infra.
 *
 * `invalidatePrefix(prefix)` → `tenantCache.invalidatePattern(\`${prefix}*\`)`
 * (o port acrescenta o `*`; o comportamento de invalidação é
 * idêntico ao `invalidatePattern("x:*")` original).
 */
export const alsTenantCache: TenantCache = {
  get: (key) => tenantCache.get(key),
  set: (key, value, options) => tenantCache.set(key, value, options),
  invalidatePrefix: (prefix) => tenantCache.invalidatePattern(`${prefix}*`),
};
