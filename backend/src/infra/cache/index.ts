import { MemoryCache } from "./memory-cache.js";
import { ICacheClient, CacheEntry, CacheOptions, matchesPattern } from "./cache-client.js";
import { resolveTenantSchemaInScope } from "../db/tenant-context.js";
import { RedisCacheClient } from "./redis-cache-client.js";

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

function scopedKey(key: string): string {
  return `${resolveTenantSchemaInScope()}:${key}`;
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
