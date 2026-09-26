import { ICacheClient, CacheEntry, CacheOptions, matchesPattern } from "./cache-client.js";

export class MemoryCache implements ICacheClient {
  private store = new Map<string, CacheEntry>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, options?: CacheOptions): void {
    const ttl = options?.ttl ?? 300;
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidatePattern(pattern: string): void {
    for (const key of this.store.keys()) {
      if (matchesPattern(key, pattern)) {
        this.store.delete(key);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }
}
