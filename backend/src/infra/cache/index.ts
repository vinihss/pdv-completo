import { MemoryCache } from "./memory-cache.js"
import { ICacheClient, CacheEntry, CacheOptions, matchesPattern } from "./cache-client.js"

import { RedisCacheClient } from "./redis-cache-client.js"

// Cache instance - starts with MemoryCache for boot compatibility,
// then switches to Redis once connection is established.
// Em produção, o Redis deve estar sempre disponível.
let cacheInstance: ICacheClient = new MemoryCache()

/**
 * Initialize the cache system.
 * Must be called after Redis connection is established (typically in Fastify plugin setup).
 * 
 * @param useRedis - Force enable Redis even if connection fails (throws)
 * @returns Promise that resolves when cache is ready
 */
export async function initCache(useRedis: boolean = true): Promise<ICacheClient> {
  try {
    // Testar conexão Redis
    await import("./redis-cache-client.js")
    // Se conseguimos importar, tenta usar Redis
    const rc = new RedisCacheClient()
    // Test with a simple operation to verify connection
    await rc.get<string>("__cache_test__")
    // If we get here, Redis is available
    cacheInstance = rc
    // eslint-disable-next-line no-console
    console.info("Cache initialized with Redis")
    return cacheInstance
  } catch (err) {
    if (useRedis) {
      // eslint-disable-next-line no-console
      console.warn("Redis unavailable, falling back to MemoryCache", err)
      // Manter MemoryCache como fallback
      cacheInstance = new MemoryCache()
      return cacheInstance
    } else {
      // eslint-disable-next-line no-console
      console.info("Cache using MemoryCache (Redis disabled)")
      cacheInstance = new MemoryCache()
      return cacheInstance
    }
  }
}

/**
 * Get the current cache instance (Redis or Memory).
 */
export function getCache(): ICacheClient {
  return cacheInstance
}

/**
 * Reset the cache instance to MemoryCache.
 * Útil para testes ou quando Redis cai e precisa reinitializar.
 */
export function resetCache(): void {
  cacheInstance = new MemoryCache()
  // eslint-disable-next-line no-console
  console.info("Cache reset to MemoryCache")
}

/**
 * Check if current cache is using Redis.
 */
export function isUsingRedis(): boolean {
  return cacheInstance instanceof RedisCacheClient
}

/**
 * Convenience functions for common cache operations with typed keys.
 * 
 * Usage:
 *  const cached = await getCache().get<Produto>(`produto:${id}`)
 *  await getCache().set(`produto:${id}`, produto, { ttl: 300 })
 */
export async function get<T>(key: string): Promise<T | null> {
  return getCache().get<T>(key)
}

export async function set<T>(
  key: string,
  value: T,
  options?: CacheOptions
): Promise<void> {
  await getCache().set<T>(key, value, options)
}

export async function invalidate(key: string): Promise<void> {
  await getCache().invalidate(key)
}

export async function invalidatePattern(pattern: string): Promise<void> {
  await getCache().invalidatePattern(pattern)
}

export async function clear(): Promise<void> {
  await getCache().clear()
}