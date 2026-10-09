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
  get<T>(key: string): T | null {
    return getCache().get<T>(scopedKey(key)) as any;
  },
  set<T>(key: string, value: T, options?: CacheOptions): void {
    getCache().set<T>(scopedKey(key), value, options) as any;
  },
  invalidate(key: string): void {
    getCache().invalidate(scopedKey(key)) as any;
  },
  invalidatePattern(pattern: string): void {
    getCache().invalidatePattern(scopedKey(pattern)) as any;
  },
};
