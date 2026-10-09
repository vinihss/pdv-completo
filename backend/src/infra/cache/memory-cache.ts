import { ICacheClient, CacheEntry, CacheOptions, matchesPattern } from "./cache-client.js"

export class MemoryCache implements ICacheClient {
  private store = new Map<string, CacheEntry>()

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }
    return entry.value as T
  }

  async set<T>(key: string, value: T, options?: CacheOptions): Promise<void> {
    const ttl = options?.ttl ?? 300
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    })
  }

  async invalidate(key: string): Promise<void> {
    this.store.delete(key)
  }

  async invalidatePattern(pattern: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (matchesPattern(key, pattern)) {
        this.store.delete(key)
      }
    }
  }

  async clear(): Promise<void> {
    this.store.clear()
  }

  async getTtl(key: string): Promise<number | null> {
    const entry = this.store.get(key)
    if (!entry) return null
    const remaining = Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000))
    return remaining > 0 ? remaining : null
  }
}