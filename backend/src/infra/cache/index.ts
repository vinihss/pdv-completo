import { MemoryCache } from "./memory-cache.js";
import { ICacheClient, CacheEntry, CacheOptions, matchesPattern } from "./cache-client.js";
import { currentTenantId } from "../db/tenant-context.js";
import { RedisCacheClient, closeRedis } from "./redis-cache-client.js";

let instance: ICacheClient | null = null;
let cacheInstance: ICacheClient = new MemoryCache();

export async function initCache(useRedis: boolean = true): Promise<ICacheClient> {
  try {
    await import("./redis-cache-client.js");
    const rc = new RedisCacheClient();
    await rc.get<string>("__cache_test__");
    cacheInstance = rc;
    console.info("Cache initialized with Redis");
    return cacheInstance;
  } catch (err) {
    if (useRedis) {
      console.warn("Redis unavailable, falling back to MemoryCache", err);
      // O probe falhou: fechar o singleton para ele não ficar
      // reconectando em background enquanto rodamos em memória.
      closeRedis();
      cacheInstance = new MemoryCache();
      return cacheInstance;
    } else {
      console.info("Cache using MemoryCache (Redis disabled)");
      cacheInstance = new MemoryCache();
      return cacheInstance;
    }
  }
}

export function getCache(): ICacheClient {
  return cacheInstance;
}

export function resetCache(): void {
  cacheInstance = new MemoryCache();
  console.info("Cache reset to MemoryCache");
}

export function isUsingRedis(): boolean {
  return cacheInstance instanceof RedisCacheClient;
}

/**
 * A chave do cache é particionada pelo TENANT, não pelo schema: no modelo por
 * linha todas as lojas moram no mesmo schema, e uma chave por schema
 * misturaria as lojas (o `active` de uma vazaria para a outra).
 */
function scopedKey(key: string): string {
  return `${currentTenantId()}:${key}`;
}

export const tenantCache = {
  async get<T>(key: string): Promise<T | null> {
    return getCache().get<T>(scopedKey(key));
  },
  async set<T>(key: string, value: T, options?: CacheOptions): Promise<void> {
    await getCache().set<T>(scopedKey(key), value, options);
  },
  async invalidate(key: string): Promise<void> {
    await getCache().invalidate(scopedKey(key));
  },
  async invalidatePattern(pattern: string): Promise<void> {
    await getCache().invalidatePattern(scopedKey(pattern));
  },
};
